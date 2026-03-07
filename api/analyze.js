// /api/analyze.js - Vercel serverless function (CommonJS)
const fetch = globalThis.fetch || require('node-fetch');

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64 } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  // Strip data URL prefix
  const base64Data = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');

  const prompt = `You are grading a Japanese elementary school arithmetic worksheet.

Look carefully at this image. Find all printed arithmetic problems.
For each problem, identify:
1. The problem number in parentheses e.g. (1) → 1
2. The printed equation (top number, operator, bottom number)
3. The student's handwritten answer below the horizontal line

Calculate the correct answer yourself and compare with the student's answer.

Return ONLY a JSON array, no other text, no markdown, no explanation:
[{"number":1,"operand1":562,"operator":"-","operand2":121,"correctAnswer":441,"studentAnswer":441,"isCorrect":true},...]

Important rules:
- "correctAnswer" = your own calculation result
- "studentAnswer" = what the student wrote (read handwriting carefully)
- If handwriting is unreadable, set studentAnswer to null and isCorrect to false
- Include ALL problems visible in the image
- Return ONLY the JSON array`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/jpeg', data: base64Data } }
          ]}],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
        })
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(502).json({ error: 'Gemini error', detail: errText.slice(0, 200) });
    }

    const result = await resp.json();
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return res.status(422).json({ error: 'No JSON in response', raw: text.slice(0, 300) });

    const problems = JSON.parse(match[0]);
    return res.status(200).json({ problems, source: 'gemini' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
