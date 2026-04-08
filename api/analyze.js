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

  const prompt = `You are reading a Japanese elementary school math worksheet photo.
Your job is OCR only — read what is printed and handwritten. Do NOT judge correctness yourself.

Detect the problem type and handle each accordingly:

=== TYPE A: ARITHMETIC (vertical or horizontal equations) ===
Problems with a printed equation (top number, operator, bottom number) and a handwritten answer.
Operators: +, -, ×, ÷

For each problem, return:
{
  "number": 9,
  "problemType": "arithmetic",
  "operand1": 423,
  "operator": "-",
  "operand2": 276,
  "studentAnswer": 147,
  "answerBox": [250, 150, 300, 350]
}

=== TYPE B: NON-ARITHMETIC ===
Problems that cannot be verified by calculation:
- Comparison: circle the larger number (大きい方を○で囲む)
- Ordering: write numbers in order (大きい順に番号をかく)
- Sequences: fill in the blank (□にあう数をかく)
- Word problems (文章題)
- Any other type

For each problem/blank, return:
{
  "number": 1,
  "problemType": "other",
  "problemDescription": "Circle the larger: (40, 30)",
  "correctAnswer": "40",
  "studentAnswer": "40",
  "isCorrect": true,
  "answerBox": [150, 100, 200, 250]
}

=== RULES ===
- Return ALL problems found as a single JSON array (mix of Type A and B is fine)
- "answerBox": [y_min, x_min, y_max, x_max] normalized to 0-1000 (0,0=top-left)
- "studentAnswer": exactly what the student wrote. null if unreadable/blank.
- "confidence": how confident you are in reading the student's handwritten answer. "high", "medium", or "low".
  - "high": digits are clearly legible, no ambiguity
  - "medium": mostly readable but one or more digits are ambiguous
  - "low": very hard to read, guessing
  - If blank or completely unreadable, set studentAnswer to null and confidence to "low"
- For Type A: only read numbers, do NOT calculate the answer yourself.
- For Type B: YOU determine isCorrect and correctAnswer.
- For ordering problems: treat each numbered box as a separate entry.
- For sequences: treat each blank as a separate entry.
- Order results by problem number.
- IMPORTANT: Be strict about reading handwritten digits. If you are not sure about even one digit, set confidence to "low". It is better to mark as uncertain than to guess wrong.`;

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
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } }
        })
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(502).json({ error: 'Gemini error', detail: errText.slice(0, 300) });
    }

    const result = await resp.json();
    const parts = result?.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text || '').join('\n');

    if (!text.trim()) {
      return res.status(422).json({ error: 'Empty response from Gemini' });
    }

    let problems;
    try {
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned);
      problems = Array.isArray(parsed) ? parsed : (parsed.problems || parsed.data || []);
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return res.status(422).json({ error: 'No JSON found', raw: text.slice(0, 500) });
      problems = JSON.parse(match[0]);
    }
    return res.status(200).json({ problems, source: 'gemini' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
