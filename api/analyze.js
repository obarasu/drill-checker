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

  const prompt = `You are grading a Japanese elementary school math worksheet.

Read ALL problems on the worksheet and grade each one.
Handle ANY problem type:
- Arithmetic (addition, subtraction, multiplication, division) — vertical or horizontal format
- Word problems (文章題)
- Comparison (circle the larger number: 大きい方を○で囲む)
- Ordering (write numbers in order: 大きい順に番号をかく)
- Number sequences (fill in the blank: □にあう数をかく)
- Any other math problem type

For each problem:
1. Read the problem number (e.g. (1), (2), ...)
2. Read the full printed problem
3. Read the student's handwritten answer
4. Calculate or determine the CORRECT answer yourself
5. Check if the student's answer matches the correct answer
6. Find the bounding box of the student's handwritten answer area

Return a JSON array:
[
  {
    "number": 1,
    "type": "addition",
    "correctAnswer": "327",
    "studentAnswer": "327",
    "isCorrect": true,
    "answerBox": [250, 150, 300, 350]
  }
]

IMPORTANT:
- "number": the problem number as integer
- "type": brief description in English (addition, subtraction, multiplication, division, comparison, ordering, sequence, word_problem, other)
- "correctAnswer": the right answer as a string
- "studentAnswer": exactly what the student wrote, as a string. If blank or unreadable, use ""
- "isCorrect": true if student's answer is correct, false otherwise. Blank = false.
- "answerBox": [y_min, x_min, y_max, x_max] bounding box of the student's written answer, normalized to 0-1000 (0,0 = top-left, 1000,1000 = bottom-right)
- For comparison problems: check if the student circled the correct (larger) number
- For ordering problems: check each numbered box individually
- For sequences: check each blank individually — treat each blank as a separate problem entry
- Return ALL problems/blanks found, ordered by problem number
- If completely unreadable, still include the entry with isCorrect: false`;

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
