const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

const STATE_FILE = path.join(__dirname, '../data/last_seen.json');
const CAFE_ID = 'costco12';
const BOARD_NAME = '코스트코 쇼핑후기';
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

// ─── Naver Login ─────────────────────────────────────────────────────────────

async function naverLogin(page) {
  await page.goto('https://nid.naver.com/nidlogin.login?mode=form', {
    waitUntil: 'domcontentloaded',
  });

  // Naver 봇 감지 우회: native setter로 값 입력
  await page.evaluate((val) => {
    const el = document.querySelector('#id');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      .set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, process.env.NAVER_ID);

  await page.evaluate((val) => {
    const el = document.querySelector('#pw');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      .set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, process.env.NAVER_PW);

  await page.click('.btn_login');
  await page.waitForTimeout(3000);

  const url = page.url();
  if (url.includes('nidlogin') || url.includes('/login')) {
    throw new Error('네이버 로그인 실패. 아이디/비밀번호를 확인하세요.');
  }

  console.log('네이버 로그인 성공');
}

// ─── Cafe Scraping ───────────────────────────────────────────────────────────

async function scrapeBoard(page) {
  // 카페 메인 접속 후 게시판 URL 추출
  await page.goto(`https://cafe.naver.com/${CAFE_ID}`, {
    waitUntil: 'domcontentloaded',
  });

  await page.waitForSelector('#cafe_main', { timeout: 10000 });

  // iframe에서 게시판 링크 찾기
  const frame = page.frameLocator('#cafe_main');

  const boardHref = await frame
    .locator(`a`)
    .evaluateAll((anchors, name) => {
      const el = anchors.find((a) => a.textContent.trim() === name);
      return el ? el.href : null;
    }, BOARD_NAME);

  if (!boardHref) {
    throw new Error(`게시판을 찾을 수 없습니다: ${BOARD_NAME}`);
  }

  console.log(`게시판 URL: ${boardHref}`);

  // 게시판 직접 접속 (iframe 우회)
  await page.goto(boardHref, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // 게시글 추출
  const articles = await page.evaluate(() => {
    const rows = document.querySelectorAll(
      '.article-list tbody tr, .board-list tbody tr'
    );
    const results = [];

    rows.forEach((row) => {
      // 공지사항 제외
      if (row.classList.contains('notice') || row.querySelector('.ico_notice')) {
        return;
      }

      const titleEl =
        row.querySelector('.article-title a') ||
        row.querySelector('.b-title a') ||
        row.querySelector('td.td_article a');

      if (!titleEl) return;

      const href = titleEl.href || '';
      const title = titleEl.textContent.trim();
      const idMatch = href.match(/articleid=(\d+)/i) || href.match(/\/(\d+)(?:\?|$)/);
      const id = idMatch ? idMatch[1] : '';

      if (id && title) {
        results.push({ id, title, link: href });
      }
    });

    return results;
  });

  return articles;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!SLACK_WEBHOOK) {
    throw new Error('SLACK_WEBHOOK_URL 환경변수가 없습니다.');
  }
  if (!process.env.NAVER_ID || !process.env.NAVER_PW) {
    throw new Error('NAVER_ID 또는 NAVER_PW 환경변수가 없습니다.');
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

    await naverLogin(page);
    const articles = await scrapeBoard(page);

    console.log(`총 ${articles.length}개 글 발견`);

    const newArticles = articles.filter(
      (a) => !state.lastSeenIds.includes(a.id)
    );

    if (newArticles.length === 0) {
      console.log('새 글 없음');
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
