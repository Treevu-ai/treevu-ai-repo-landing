export default function handler(req, res) {
  const key = process.env.NOTION_API_KEY || '';
  res.json({
    length: key.length,
    lastCharCode: key.charCodeAt(key.length - 1),
    first10: key.slice(0, 10),
    last5: key.slice(-5),
    repr: JSON.stringify(key.slice(-3)),
  });
}
