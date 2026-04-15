const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

const STATE_FILE = path.join(__dirname, '../data/last_seen.json');
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;

// ─── State Management ────────────────────────────────────────────────────────

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return { lastSeenIds: [] };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Slack ───────────────────────────────────────────────────────────────────

async function sendSlackMessage(text) {
  const payload = JSON.stringify({ text });
  return new Promise((resolve, reject) => {
    const url = new URL(SLACK_WEBHOOK);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Naver Cookie Login ───────────────────────────────────────────────────────

async function loadNaverCookies(context) {
  const cookieBase64 = process.env.NAVER_COOKIES;
  if (!cookieBase64) {
    throw new Error('NAVER_COOKIES 환경변수가 없습니다. save-cookies.js를 먼저 실행하세요.');
  }
  const cookies = JSON.parse(Buffer.from(cookieBase64, 'base64').toString('utf8'));
  await context.addCookies(cookies);
  console.log('쿠키 로드 완료');
}

async function verifyCafeAccess(page) {
  await page.goto('https://cafe.naver.com/costco12', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // 로그인 페이지로 리다이렉트됐으면 쿠키 만료
  if (page.url().includes('nidlogin') || page.url().includes('/login')) {
    throw new Error('쿠키가 만료되었습니다. save-cookies.js를 다시 실행해서 NAVER_COOKIES를 갱신하세요.');
  }
  console.log('카페 접근 확인');
}

// ─── Cafe Scraping ───────────────────────────────────────────────────────────

// 카페 클럽 ID, 메뉴 ID (고정값)
const CLUB_ID = '25559875';
const MENU_ID = '12';
const BOARD_URL = `https://cafe.naver.com/f-e/cafes/${CLUB_ID}/menus/${MENU_ID}?viewType=L`;

async function scrapeBoard(page) {
  await page.goto(BOARD_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // 게시글 링크 추출 (댓글 링크 제외)
  const articles = await page.evaluate((clubId) => {
    const pattern = new RegExp(`/f-e/cafes/${clubId}/articles/(\\d+)\\?`);
    const seen = new Set();
    const results = [];

    document.querySelectorAll(`a[href*="/articles/"]`).forEach((a) => {
      // 댓글 링크 제외
      if (a.href.includes('commentFocus')) return;

      const match = a.href.match(pattern);
      if (!match) return;

      const id = match[1];
      if (seen.has(id)) return;
      seen.add(id);

      const title = a.textContent.trim();
      if (!title) return;

      results.push({ id, title, link: `https://cafe.naver.com/costco12/${id}` });
    });

    return results;
  }, CLUB_ID);

  return articles;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!SLACK_WEBHOOK) {
    throw new Error('SLACK_WEBHOOK_URL 환경변수가 없습니다.');
  }
  if (!process.env.NAVER_COOKIES) {
    throw new Error('NAVER_COOKIES 환경변수가 없습니다.');
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ko-KR',
  });

  const page = await context.newPage();

  try {
    const state = loadState();

    await loadNaverCookies(context);
    await verifyCafeAccess(page);
    const articles = await scrapeBoard(page);

    console.log(`총 ${articles.length}개 글 발견`);

    const newArticles = articles.filter(
      (a) => !state.lastSeenIds.includes(a.id)
    );

    if (newArticles.length === 0) {
      console.log('새 글 없음');
      await sendSlackMessage('코스트코 쇼핑후기 새 글 없음');
      return;
    }

    console.log(`새 글 ${newArticles.length}개 발견!`);

    for (const article of newArticles) {
      const message = [
        `*[코스트코 쇼핑후기] 새 글 알림*`,
        `*제목:* ${article.title}`,
        `*링크:* ${article.link}`,
      ].join('\n');

      await sendSlackMessage(message);
      console.log(`슬랙 전송: ${article.title}`);
    }

    // 최근 200개 ID만 보관
    const updatedIds = [
      ...newArticles.map((a) => a.id),
      ...state.lastSeenIds,
    ].slice(0, 200);

    saveState({ lastSeenIds: updatedIds });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('오류 발생:', err.message);
  process.exit(1);
});
