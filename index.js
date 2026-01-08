const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();

app.use(express.json({ limit: '20mb' }));

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

/* 
    [MCP 기능 이식] 특정 채널 번호의 흐름 추출 함수
    - 채널 번호 입력 시, 해당 채널 번호의 흐름을 추출해줌
*/
function extractChannelHistoryFromText(text, channelNumber) {

    const lines = text.split('\n');    
    let channelLog = '';
    const targetPattern = `[${channelNumber}]`;

    for (const line of lines) {
        // channelNumber가 포함된 라인만 처리
        if (line.includes(channelNumber)) {
            const timeMatch = line.match(/\d{2}:\d{2}:\d{2}\.\d{3}/); // 시간만 추출 (날짜 생략)
            const time = timeMatch ? timeMatch[0] : "";

            // [0041] 이후의 대괄호 블록들만 추출하여 노이즈 제거
            const blocks = line.match(/\[(.*?\.dxml|.*?|.*?)\]/g);

            if (blocks) {
                const filteredBlocks = blocks.filter(b => !b.includes(channelNumber)); // 채널번호 중복 제거
                const status = line.includes("Start") ? "▶" : line.includes("End") ? "■" : "";

                // 한 줄을 아주 짧게 포맷팅
                channelLog += `${time} ${status} ${filteredBlocks.join("")}\n`;
            }
        }
    }
    return channelLog || '해당 채널 번호의 흐름을 찾을 수 없습니다.';
}

/* 
    [MCP 기능 이식] IVR 로그 분석 함수
    - 메일 본문과 로그 이미지를 입력 받아, 해당 채널 번호의 흐름을 추출해줌
*/
app.post('/analyze-ivr-log', async (req, res) => {
    try {
        const { mailContent, logImageBase64, logText } = req.body;

        // 1. 모델 설정 수정 (apiVersion 제거 - 최신 SDK는 자동으로 v1을 잡습니다)
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        // base64 이미지 데이터 전처리
        const pureBase64 = logImageBase64.includes(",") 
        ? logImageBase64.split(",")[1] 
        : logImageBase64;


        // STEP 1: 채널번호 추출 (response 뒤에 괄호 () 제거)
        const extractPrompt = `다음 이메일 본문에서 IVR 채널 번호(숫자 4자리)를 찾아줘. 
        만약 채널 번호가 보인다면 숫자만 딱 적어서 대답해주고, 없으면 'UNKNOWN'으로 대답해줘.
        이메일 본문: "${mailContent}"`;        

        const extractResult = await model.generateContent(extractPrompt);
        // 중요: .response().text() -> .response.text() 로 수정
        const channelNumber = extractResult.response.text().trim();
        console.log('채널 번호 추출 성공:', channelNumber);
        
        let filteredLog = logText;

        // STEP 2: 채널 번호 필터링
        if (channelNumber !== 'UNKNOWN' && /^\d+$/.test(channelNumber)) {
            filteredLog = extractChannelHistoryFromText(logText, channelNumber);
        }

        // STEP 3: 최종 이미지 + 텍스트 분석
        const imagePart = {
            inlineData: {
                data: pureBase64, // 전처리된 순수 데이터 사용
                mimeType: "image/png" // 또는 image/png
            }
        };

        const analysisPrompt = `
            [메일 요약]: ${mailContent}
            [추출된 채널로그]: ${filteredLog}
            [채널번호]: ${channelNumber}

            위의 데이터와 첨부된 로그 이미지를 대조하여 다음을 분석해줘:
            1. 현재 발생한 주요 에러나 특이사항이 무엇인가?
            2. 로그상에서 흐름이 끊기거나 비정상 종료된 지점은 어디인가?
            3. 해결을 위해 어떤 조치가 필요한가?            
        `;

        const finalAnalyze = await model.generateContent([analysisPrompt, imagePart]);
        const analysisText = finalAnalyze.response.text(); // 여기도 괄호 없음 확인

        res.json({
            success: true,
            channelNumber: channelNumber,
            analysis: analysisText,
        });

    } catch (error) {
        console.error('실제 발생 에러:', error); // 터미널 로그 확인용
        res.status(500).json({ error: 'Failed to analyze IVR log', details: error.message });
    }
});

/* app.post('/analyze-ivr-log', async (req, res) => {
    try {
        console.log("직접 호출(Fetch) 방식 테스트 시작");
        const { mailContent, logImageBase64, logText } = req.body;
        const apiKey = process.env.GEMINI_API_KEY;

        // 라이브러리 대신 직접 주소를 입력합니다 (v1 사용)
        // index.js URL 수정
        // URL의 모델명을 gemini-2.5-flash로 변경
        const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

        const payload = {
            contents: [{
                parts: [{ text: "Hello! If you receive this, reply with 'DIRECT_SUCCESS'." }]
            }]
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(`Google API Error: ${data.error ? data.error.message : response.statusText}`);
        }

        res.json({
            success: true,
            message: "직접 호출 성공!",
            geminiReply: data.candidates[0].content.parts[0].text
        });

    } catch (error) {
        console.error('직접 호출 에러:', error);
        res.status(500).json({ 
            error: 'Direct Fetch Failed', 
            details: error.message 
        });
    }
}); */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});