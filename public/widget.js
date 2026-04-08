const DEFAULT_CHANNEL = "r77_ai";
const DEFAULT_SITE_URL = "https://r77.ai";
const DEFAULT_SITE_NAME = "R77 AI";

const titleEl = document.getElementById("channel-title");
const subsEl = document.getElementById("channel-subscribers");
const linkEl = document.getElementById("channel-link");
const postsContainer = document.getElementById("posts-container");
const poweredEl = document.getElementById("widget-powered");

function getConfigFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const channel = (params.get("channel") || DEFAULT_CHANNEL).replace("@", "").trim();
  const planRaw = (params.get("plan") || "paid").toLowerCase();
  const plan = planRaw === "paid" ? "paid" : "free";
  const siteUrl = (params.get("siteUrl") || DEFAULT_SITE_URL).trim();
  const siteName = (params.get("siteName") || DEFAULT_SITE_NAME).trim();
  return { channel, plan, siteUrl, siteName };
}

function formatNumber(value) {
  return new Intl.NumberFormat("ru-RU").format(value || 0);
}

function formatPostDate(dateValue) {
  if (!dateValue) return "";
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) return "";

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short"
  }).format(parsed);
}

function escapeHtml(value) {
  return (value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMedia(media, postText) {
  if (!media || !media.url) return "";

  const safeUrl = escapeHtml(media.url);
  const alt = escapeHtml(postText || "Post media");
  const isVideo = media.type === "video";

  return `
    <div class="post__media">
      <img src="${safeUrl}" alt="${alt}" loading="lazy" />
      ${isVideo ? '<span class="post__media-badge">▶ Видео</span>' : ""}
    </div>
  `;
}

function sanitizePostHtml(html) {
  if (!html) return "";

  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;

  const allowed = new Set(["B", "STRONG", "I", "EM", "U", "S", "A", "CODE", "PRE", "BLOCKQUOTE", "BR"]);
  const nodes = wrapper.querySelectorAll("*");
  for (const node of nodes) {
    if (!allowed.has(node.tagName)) {
      node.replaceWith(document.createTextNode(node.textContent || ""));
      continue;
    }

    const attrs = Array.from(node.attributes);
    for (const attr of attrs) {
      const isSafeHref = node.tagName === "A" && attr.name === "href";
      if (!isSafeHref) node.removeAttribute(attr.name);
    }
  }

  return wrapper.innerHTML;
}

function renderText(text, textHtml) {
  const cleanHtml = sanitizePostHtml((textHtml || "").trim());
  if (cleanHtml) return `<div class="post__text">${cleanHtml}</div>`;

  const safeText = escapeHtml((text || "").trim());
  if (!safeText || safeText === "Пост без текста") return "";
  return `<div class="post__text">${safeText}</div>`;
}

function renderPosts(posts) {
  if (!posts.length) {
    postsContainer.innerHTML = '<div class="error">Посты не найдены.</div>';
    return;
  }

  const orderedPosts = [...posts].sort((a, b) => (a.id || 0) - (b.id || 0));
  const isTwoColumn = window.matchMedia("(min-width: 980px)").matches;
  const visiblePosts = isTwoColumn && orderedPosts.length % 2 !== 0 ? orderedPosts.slice(1) : orderedPosts;

  postsContainer.innerHTML = visiblePosts
    .map(
      (post) => `
      <article class="post">
        ${renderMedia(post.media, post.text)}
        ${renderText(post.text, post.textHtml)}
        <div class="post__footer">
          <div class="post__stats">
            <span class="stat">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 20.4 4.8 13.6a4.8 4.8 0 0 1 6.8-6.8L12 7.2l.4-.4a4.8 4.8 0 1 1 6.8 6.8L12 20.4z"></path>
              </svg>
              ${formatNumber(post.likes)}
            </span>
            <span class="stat">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5c-5.8 0-9.7 5.4-10 5.9a1 1 0 0 0 0 1.1C2.3 12.6 6.2 18 12 18s9.7-5.4 10-5.9a1 1 0 0 0 0-1.1C21.7 10.4 17.8 5 12 5zm0 10a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"></path>
              </svg>
              ${formatNumber(post.views)}
            </span>
          </div>
          <div class="post__meta">
            <span class="post__date">${formatPostDate(post.date)}</span>
            <a class="post__link" href="${post.url}" target="_blank" rel="noreferrer">Пост</a>
          </div>
        </div>
      </article>
    `
    )
    .join("");

  // In one-column mode keep Telegram-like behavior: newest post is at the bottom.
  if (!isTwoColumn) {
    requestAnimationFrame(() => {
      postsContainer.scrollTop = postsContainer.scrollHeight;
    });
  } else {
    postsContainer.scrollTop = 0;
  }
}

function renderPowered(config) {
  if (config.plan !== "free") {
    poweredEl.hidden = true;
    return;
  }

  const safeSiteUrl = escapeHtml(config.siteUrl);
  const safeSiteName = escapeHtml(config.siteName);
  poweredEl.innerHTML = `Виджет от <a href="${safeSiteUrl}" target="_blank" rel="noreferrer">${safeSiteName}</a>`;
  poweredEl.hidden = false;
}

async function init() {
  const config = getConfigFromUrl();

  try {
    const response = await fetch(`/api/channel/${config.channel}`);
    if (!response.ok) throw new Error("Failed to load channel");

    const data = await response.json();
    titleEl.textContent = data.title || config.channel;
    subsEl.textContent = `Подписчики: ${formatNumber(data.subscribers)}`;
    linkEl.href = data.channelUrl;

    renderPosts(data.posts || []);
    renderPowered(config);
  } catch (error) {
    postsContainer.innerHTML = '<div class="error">Ошибка загрузки данных канала.</div>';
  }
}

init();
