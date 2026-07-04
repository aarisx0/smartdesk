const axios = require('axios');
const path = require('path');

const WATSONX_API_URL = process.env.WATSONX_API_URL || 'https://us-south.ml.cloud.ibm.com/ml/v1/text/generation';
const WATSONX_API_KEY = process.env.WATSONX_API_KEY;
const WATSONX_PROJECT_ID = process.env.WATSONX_PROJECT_ID;
const MODEL_ID = process.env.WATSONX_MODEL_ID || 'ibm/granite-13b-instruct-v2';

// Maps category → target subfolder name
const CATEGORY_FOLDER_MAP = {
  'document': 'Documents',
  'image': 'Images',
  'video': 'Videos',
  'audio': 'Audio',
  'code': 'Code',
  'spreadsheet': 'Spreadsheets',
  'presentation': 'Presentations',
  'archive': 'Archives',
  'other': 'Misc',
};

/**
 * Retrieve an IBM IAM Bearer token from the API key.
 */
async function getIAMToken() {
  const response = await axios.post(
    'https://iam.cloud.ibm.com/identity/token',
    new URLSearchParams({
      grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
      apikey: WATSONX_API_KEY,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return response.data.access_token;
}

/**
 * Classify a file using IBM watsonx Granite.
 * @param {{ filePath: string, ext: string, fileName: string }} param
 * @returns {{ category: string, confidence: number, targetPath: string }}
 */
async function classifyFile({ filePath, ext, fileName }) {
  if (!WATSONX_API_KEY || !WATSONX_PROJECT_ID) {
    return mockClassify({ ext, fileName, filePath });
  }

  try {
    const token = await getIAMToken();

    const prompt = buildPrompt({ fileName, ext });

    const { data } = await axios.post(
      `${WATSONX_API_URL}?version=2023-05-29`,
      {
        model_id: MODEL_ID,
        project_id: WATSONX_PROJECT_ID,
        input: prompt,
        parameters: {
          decoding_method: 'greedy',
          max_new_tokens: 40,
          temperature: 0.1,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const rawOutput = data?.results?.[0]?.generated_text?.trim().toLowerCase() ?? '';
    const category = parseCategory(rawOutput);
    const confidence = parseConfidence(rawOutput);

    const baseDir = path.dirname(filePath);
    const targetFolder = CATEGORY_FOLDER_MAP[category] ?? 'Misc';
    const targetPath = path.join(baseDir, targetFolder, fileName);

    return { category, confidence, targetPath };
  } catch (err) {
    console.error('[watsonx]', err.message);
    return mockClassify({ ext, fileName, filePath });
  }
}

/** Build a structured prompt for Granite */
function buildPrompt({ fileName, ext }) {
  return `Classify the following file into exactly one category.
Categories: document, image, video, audio, code, spreadsheet, presentation, archive, other.

File name: ${fileName}
File extension: ${ext}

Respond with JSON only: {"category": "<category>", "confidence": <0-100>}`;
}

function parseCategory(text) {
  try {
    const json = JSON.parse(text.match(/\{.*\}/s)?.[0] ?? '{}');
    const raw = (json.category ?? '').toLowerCase();
    return CATEGORY_FOLDER_MAP[raw] ? raw : 'other';
  } catch {
    return 'other';
  }
}

function parseConfidence(text) {
  try {
    const json = JSON.parse(text.match(/\{.*\}/s)?.[0] ?? '{}');
    const val = Number(json.confidence);
    return Number.isFinite(val) ? Math.min(100, Math.max(0, val)) : 75;
  } catch {
    return 75;
  }
}

/** Fallback rule-based classifier when API key is not configured */
function mockClassify({ ext, fileName, filePath }) {
  const rules = {
    document: ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.odt'],
    image: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico'],
    video: ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm'],
    audio: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a'],
    code: ['.js', '.ts', '.py', '.java', '.cs', '.cpp', '.go', '.rs', '.rb', '.php'],
    spreadsheet: ['.xls', '.xlsx', '.csv', '.ods'],
    presentation: ['.ppt', '.pptx', '.odp', '.key'],
    archive: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'],
  };

  let category = 'other';
  for (const [cat, exts] of Object.entries(rules)) {
    if (exts.includes(ext)) { category = cat; break; }
  }

  const baseDir = path.dirname(filePath);
  const targetFolder = CATEGORY_FOLDER_MAP[category] ?? 'Misc';
  return {
    category,
    confidence: 80,
    targetPath: path.join(baseDir, targetFolder, fileName),
  };
}

module.exports = { classifyFile };
