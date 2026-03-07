// /api/analyze.js - Vercel serverless function (CommonJS)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64 } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  const base64Data = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');

  const prompt = `You are grading a Japanese elementary school arithmetic worksheet photo.

Find all arithmetic problems in the image. For each problem:
1. Read the problem number in parentheses, e.g. (1) → 1
2. Read the printed equation (top number, operator, bottom number)
3. Find the student's handwritten answer below the horizontal line
4. Calculate the correct answer yourself
5. Estimate the CENTER position of the student's handwritten answer as a percentage of the image size (x% from left edge, y% from top edge)

Return ONLY a JSON array. No markdown, no explanation, just the array:
[
  {
    "number": 1,
    "operand1": 562,
    "operator": "-",
    "operand2": 121,
    "correctAnswer": 441,
    "studentAnswer": 441,
    "isCorrect": true,
    "answerX": 28,
    "answerY": 35
  },
  ...
]

IMPORTANT:
- "answerX" and "answerY" are the position of the student's handwritten answer as % of image width/height
- "correctAnswer" = your own calculation (double-check!)
- "studentAnswer" = what the student actually wrote (read handwriting carefully)
- If unreadable, set studentAnswer to null, isCorrect to false
- Return ALL problems found
- Return ONLY the JSON array, nothing else`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/jpeg', data: base64Data } }
          ]}],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
        })
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(502).json({ error: 'Gemini error', detail: errText.slice(0, 300) });
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
