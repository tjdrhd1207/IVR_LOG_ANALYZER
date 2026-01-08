const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // 속도가 빠른 flash 모델 추천

    // STEP1: 메일 내용에서 채널번호 추출하기
    const extractPrompt = `다음 이메일 본문에서 IVR 채널 번호(숫자 4자리)를 찾아줘. 
    만약 채널 번호가 보인다면 숫자만 딱 적어서 대답해주고, 없으면 'UNKNOWN'으로 대답해줘.
    이메일 본문: "${mailContent}"`;        

    const extractResult = await model.generateContent(extractPrompt);
    const channelNumber = extractResult.response().text().trim();
    console.log('채널 번호:', channelNumber);
    
    let filteredLog = logText; // 기본값은 전체 로그

    // STEP 2: 채널 번호가 있다면 로그 텍스트 필터링
    if (channelNumber !== 'UNKNOWN' && /^\d+$/.test(channelNumber)) {
        filteredLog = extractChannelHistoryFromText(logText, channelNumber);
    }

    // STEP 3: 최종 이미지 + 텍스트 분석
    const imagePart = {
        inlineData: {
            data: logImageBase64.split(",")[1] || logImageBase64,
            mimeType: "image/png"
        }
    }

    const analysisPrompt = `
        [메일 요약]: ${mailContent}
        [추출된 채널로그]: ${filteredLog}
        [채널번호]: ${channelNumber}

        위의 이미지 로그와 추출된 텍스트를 바탕으로 IVR 흐름에서 에러 원인을 분석해줘.
    `

    const finalAnalyze = await model.generateContent([analysisPrompt, imagePart]);
    const analysisText = finalAnalyze.response.text();

    // 분석 결과 반환
    res.json({
            success: true,
            channelNumber: channelNumber,
            analysis: analysisText,
        });
    } catch (error) {
        console.error('Error analyzing IVR log:', error);
        res.status(500).json({ error: 'Failed to analyze IVR log', details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});