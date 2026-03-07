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

  const prompt = `You are reading a Japanese elementary school arithmetic worksheet photo.
Your job is OCR only — read what is printed and handwritten. Do NOT calculate answers yourself.

For each problem:
1. Read the problem number in parentheses, e.g. (9) → 9
2. Read the printed equation: top number, operator (+, -, ×, ÷), bottom number
3. Read the student's HANDWRITTEN answer below the horizontal line. Read each digit carefully.
4. Find the position to place a small grading mark. The mark should go just to the RIGHT of the last digit of operand2 (the bottom number of the equation). Report this as markerX (% from left edge of image) and markerY (% from top edge of image).

Return a JSON array:
[
  {
    "number": 9,
    "operand1": 423,
    "operator": "-",
    "operand2": 276,
    "studentAnswer": 147,
    "markerX": 35,
    "markerY": 28
  }
]

IMPORTANT:
- Do NOT calculate correct answers. Only read what is written.
- "studentAnswer" = exactly what the student wrote in handwriting below the line.
- markerX/markerY = position just to the RIGHT of the LAST DIGIT of operand2 (the second number in the equation). This is where a teacher would place a grading mark.
- If a digit is ambiguous, make your best guess.
- If completely unreadable, set studentAnswer to null.
- "operator": use "+", "-", "×", "÷"
- Return ALL problems found, ordered by problem number.`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/jpeg', data: base64Data } }
          ]}],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
        })
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(502).json({ error: 'Gemini error', detail: errText.slice(0, 300) });
    }

    const result = await resp.json();
    // Gemini 2.5 may return multiple parts (thinking + response). Concat all text parts.
    const parts = result?.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text || '').join('\n');

    if (!text.trim()) {
      return res.status(422).json({ error: 'Empty response from Gemini', parts: JSON.stringify(parts).slice(0, 300) });
    }

    // Extract JSON array from response text
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
