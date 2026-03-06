// /api/analyze.js - Vercel serverless function
// Receives base64 image, calls Gemini Flash Vision, returns graded results

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { imageBase64 } = req.body;
  if (!imageBase64) {
    return res.status(400).json({ error: 'No image provided' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  // Strip data URL prefix if present
  const base64Data = imageBase64.replace(/^data:image\/(jpeg|png|webp);base64,/, '');

  const prompt = `You are grading a Japanese elementary school arithmetic worksheet.

Look at this image carefully. Find all arithmetic problems (addition and subtraction, may include multiplication).
For each problem, read:
1. The printed equation (e.g. "555 - 351")
2. The student's handwritten answer below the line

Return ONLY a JSON array, no other text. Format:
[
  {"number": 1, "operand1": 555, "operator": "-", "operand2": 351, "correctAnswer": 204, "studentAnswer": 204, "isCorrect": true},
  ...
]

Rules:
- "number" = problem number shown in parentheses e.g. (1) -> 1
- "correctAnswer" = the mathematically correct answer (you calculate this)
- "studentAnswer" = what the student wrote (read the handwriting carefully)
- "isCorrect" = true if studentAnswer equals correctAnswer
- If you cannot read the student's handwriting, set studentAnswer to null and isCorrect to false
- Include ALL problems you can find in the image
- Respond with ONLY the JSON array, nothing else`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: 'image/jpeg', data: base64Data } }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1024
          }
        })
      }
    );

    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ error: 'Gemini API error', detail: err });
    }

    const geminiResult = await response.json();
    const text = geminiResult?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Parse JSON from Gemini response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(422).json({ error: 'Could not parse Gemini response', raw: text });
    }

    const problems = JSON.parse(jsonMatch[0]);
    return res.status(200).json({ problems });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
