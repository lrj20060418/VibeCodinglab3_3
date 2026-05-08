import {
  AMAP_KEY,
  AMAP_SECURITY_JS_CODE,
  AMAP_WEBSERVICE_KEY,
  LLM_API_KEY,
  LLM_BASE_URL,
  LLM_MODEL,
} from "./config.js";

const mapContainerId = "map";
const elCoords = document.getElementById("coords");
const elAddress = document.getElementById("address");
const elHint = document.getElementById("hint");
const elWeatherStatus = document.getElementById("weatherStatus");
const elWeatherTemp = document.getElementById("weatherTemp");
const elWeatherWind = document.getElementById("weatherWind");
const elWeatherHumidity = document.getElementById("weatherHumidity");
const elWeatherObsTime = document.getElementById("weatherObsTime");
const elChatHint = document.getElementById("chatHint");
const elChatMessages = document.getElementById("chatMessages");
const elChatForm = document.getElementById("chatForm");
const elChatInput = document.getElementById("chatInput");
const elChatSend = document.getElementById("chatSend");
const elChatClear = document.getElementById("chatClear");

function showHint(message) {
  if (elHint) elHint.textContent = message;
}

function setWeatherUI({ status, temp, wind, humidity, obsTime }) {
  if (elWeatherStatus) elWeatherStatus.textContent = status ?? "—";
  if (elWeatherTemp) elWeatherTemp.textContent = temp ?? "—";
  if (elWeatherWind) elWeatherWind.textContent = wind ?? "—";
  if (elWeatherHumidity) elWeatherHumidity.textContent = humidity ?? "—";
  if (elWeatherObsTime) elWeatherObsTime.textContent = obsTime ?? "—";
}

function validateWeatherConfig() {
  if (!AMAP_WEBSERVICE_KEY || AMAP_WEBSERVICE_KEY.includes("YOUR_AMAP_WEBSERVICE")) {
    return false;
  }
  return true;
}

function validateConfig() {
  if (
    !AMAP_KEY ||
    AMAP_KEY.includes("YOUR_AMAP") ||
    !AMAP_SECURITY_JS_CODE ||
    AMAP_SECURITY_JS_CODE.includes("YOUR_AMAP")
  ) {
    showHint("请先在 js/config.js 中填写 AMAP_KEY 与 AMAP_SECURITY_JS_CODE（参见 README）。");
    return false;
  }
  return true;
}

window._AMapSecurityConfig = {
  securityJsCode: AMAP_SECURITY_JS_CODE,
};

function setSelectionUI(lng, lat, addressText) {
  elCoords.textContent = `${lng.toFixed(6)}, ${lat.toFixed(6)}`;
  elAddress.textContent = addressText || "解析中…";
}

/** @type {{lng:number,lat:number,address?:string,adcode?:string}|null} */
let currentSelection = null;
/** @type {{weather?:string,temperature?:string,winddirection?:string,windpower?:string,humidity?:string,reporttime?:string}|null} */
let currentWeather = null;

/** @type {{role:"user"|"assistant", content:string}[]} */
const chatHistory = [];

function addChatMessage(role, content, variant = role) {
  if (!elChatMessages) return;
  const div = document.createElement("div");
  div.className = `msg ${variant}`;
  if (variant === "assistant") {
    div.innerHTML = renderMarkdown(content);
  } else {
    div.textContent = content;
  }
  elChatMessages.appendChild(div);
  elChatMessages.scrollTop = elChatMessages.scrollHeight;
}

function setChatHint(text) {
  if (elChatHint) elChatHint.textContent = text;
}

function validateLLMConfig() {
  if (
    !LLM_API_KEY ||
    LLM_API_KEY.includes("YOUR_LLM") ||
    !LLM_BASE_URL ||
    LLM_BASE_URL.includes("YOUR_LLM") ||
    !LLM_MODEL ||
    LLM_MODEL.includes("YOUR_LLM")
  ) {
    return false;
  }
  return true;
}

function buildContextText() {
  const sel = currentSelection;
  const w = currentWeather;
  const parts = [];

  if (!sel) {
    parts.push("用户尚未在地图上选点。");
  } else {
    parts.push(`用户当前选择的位置：${sel.address ?? "（地名未知）"}`);
    parts.push(`经纬度：${sel.lng.toFixed(6)}, ${sel.lat.toFixed(6)}`);
    if (sel.adcode) parts.push(`adcode：${sel.adcode}`);
  }

  if (!w) {
    parts.push("当前天气：尚未获取到天气数据。");
  } else {
    const temp = w.temperature != null ? `${w.temperature}°C` : "未知";
    const weather = w.weather ?? "未知";
    const wind =
      w.winddirection && w.windpower
        ? `${w.winddirection} ${w.windpower}`
        : "未知";
    const hum = w.humidity != null ? `${w.humidity}%` : "未知";
    const time = w.reporttime ?? "未知";
    parts.push(
      `当前天气：${weather}，温度 ${temp}，湿度 ${hum}，风 ${wind}，观测时间 ${time}。`,
    );
  }

  return parts.join("\n");
}

function escapeHtml(unsafe) {
  return String(unsafe)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function renderInlineMarkdown(text) {
  let s = escapeHtml(text);
  // inline code
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  // bold
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // italic (simple)
  s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  return s;
}

/**
 * 安全、轻量的 Markdown 渲染（覆盖实验常见输出：段落/加粗/斜体/列表/代码）。
 * - 先转义 HTML，再将 Markdown 转为受控标签
 */
function renderMarkdown(md) {
  const lines = String(md ?? "").replaceAll("\r\n", "\n").split("\n");
  const out = [];
  let i = 0;

  const flushParagraph = (buf) => {
    const text = buf.join(" ").trim();
    if (text) out.push(`<p>${renderInlineMarkdown(text)}</p>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    // blank line
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // headings (#, ##, ###)
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${renderInlineMarkdown(h[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      out.push(
        `<ul>${items
          .map((t) => `<li>${renderInlineMarkdown(t.trim())}</li>`)
          .join("")}</ul>`,
      );
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      out.push(
        `<ol>${items
          .map((t) => `<li>${renderInlineMarkdown(t.trim())}</li>`)
          .join("")}</ol>`,
      );
      continue;
    }

    // paragraph (collect until blank line)
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s+/.test(lines[i])) {
      if (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i])) break;
      buf.push(lines[i].trim());
      i += 1;
    }
    flushParagraph(buf);
  }

  return out.join("");
}

async function callChatCompletion({ userText }) {
  const systemPrompt =
    "你是一个生活出行助手。你会基于用户当前位置与天气信息，给出具体、可执行的建议。" +
    "回答要中文、简洁、可操作；必要时给出注意事项。";

  const contextText = buildContextText();

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "system", content: `上下文信息：\n${contextText}` },
    ...chatHistory,
    { role: "user", content: userText },
  ];

  const res = await fetch(LLM_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      temperature: 0.6,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.delta?.content ??
    "";
  if (!content) {
    throw new Error("LLM 返回为空（未找到 choices[0].message.content）");
  }
  return content;
}

async function fetchAmapWeatherLive({ adcode }) {
  const url = new URL("https://restapi.amap.com/v3/weather/weatherInfo");
  url.searchParams.set("city", adcode);
  url.searchParams.set("key", AMAP_WEBSERVICE_KEY);
  url.searchParams.set("extensions", "base");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`AMap Weather HTTP ${res.status}`);
  }

  const data = await res.json();
  if (data?.status !== "1") {
    throw new Error(`AMap Weather status ${data?.status ?? "unknown"}: ${data?.info ?? ""}`);
  }
  const live = Array.isArray(data?.lives) ? data.lives[0] : null;
  if (!live) {
    throw new Error("AMap Weather missing lives[0]");
  }

  return {
    weather: live.weather,
    temperature: live.temperature,
    winddirection: live.winddirection,
    windpower: live.windpower,
    humidity: live.humidity,
    reporttime: live.reporttime,
  };
}

function renderAmapWeatherLive(live) {
  currentWeather = live ?? null;
  const status = live?.weather ?? "—";
  const temp = live?.temperature != null ? `${live.temperature} °C` : "—";
  const wind =
    live?.winddirection && live?.windpower
      ? `${live.winddirection} ${live.windpower}`
      : "—";
  const humidity = live?.humidity != null ? `${live.humidity}%` : "—";
  const obsTime = live?.reporttime ?? "—";
  setWeatherUI({ status, temp, wind, humidity, obsTime });
}

function main() {
  if (typeof AMapLoader === "undefined") {
    showHint("未加载 AMapLoader，请检查 index.html 中的 loader.js 引用。");
    return;
  }

  if (!validateConfig()) return;
  const hasWeather = validateWeatherConfig();
  if (!hasWeather) {
    setWeatherUI({
      status: "未配置 AMAP_WEBSERVICE_KEY",
      temp: "—",
      wind: "—",
      humidity: "—",
      obsTime: "—",
    });
  }

  showHint("正在加载地图…");
  setChatHint("点击地图选点后再提问，AI 会自动带上该地点的天气上下文。");
  addChatMessage("assistant", "你好！先在地图上点选一个位置，然后问我天气相关的问题吧。");

  if (elChatClear) {
    elChatClear.addEventListener("click", () => {
      chatHistory.length = 0;
      if (elChatMessages) elChatMessages.innerHTML = "";
      addChatMessage("assistant", "已清空对话。请重新提问。", "meta");
    });
  }

  if (elChatForm) {
    elChatForm.addEventListener("submit", async (evt) => {
      evt.preventDefault();
      const text = (elChatInput?.value ?? "").trim();
      if (!text) return;

      if (!validateLLMConfig()) {
        addChatMessage(
          "assistant",
          "未配置大模型参数。请在 js/config.js 中填写 LLM_API_KEY、LLM_BASE_URL、LLM_MODEL。",
        );
        return;
      }

      if (!currentSelection) {
        addChatMessage("assistant", "请先在地图上点击选择一个地点。");
        return;
      }

      if (elChatSend) elChatSend.disabled = true;
      if (elChatInput) elChatInput.disabled = true;

      addChatMessage("user", text);
      chatHistory.push({ role: "user", content: text });
      addChatMessage("assistant", "思考中…", "meta");

      try {
        const answer = await callChatCompletion({ userText: text });
        // 替换最后一条 meta
        if (elChatMessages?.lastElementChild) {
          elChatMessages.lastElementChild.className = "msg assistant";
          elChatMessages.lastElementChild.innerHTML = renderMarkdown(answer);
        } else {
          addChatMessage("assistant", answer);
        }
        chatHistory.push({ role: "assistant", content: answer });
      } catch (err) {
        console.error("[LLM] 调用失败:", err);
        if (elChatMessages?.lastElementChild) {
          elChatMessages.lastElementChild.className = "msg assistant";
          elChatMessages.lastElementChild.textContent =
            "AI 调用失败：请检查 LLM_BASE_URL / Key / 模型名，或查看控制台错误信息。";
        } else {
          addChatMessage(
            "assistant",
            "AI 调用失败：请检查 LLM_BASE_URL / Key / 模型名，或查看控制台错误信息。",
          );
        }
      } finally {
        if (elChatSend) elChatSend.disabled = false;
        if (elChatInput) elChatInput.disabled = false;
        if (elChatInput) {
          elChatInput.value = "";
          elChatInput.focus();
        }
      }
    });
  }

  AMapLoader.load({
    key: AMAP_KEY,
    version: "2.0",
    plugins: ["AMap.Geocoder"],
  })
    .then((AMap) => {
      const map = new AMap.Map(mapContainerId, {
        zoom: 11,
        center: [121.473667, 31.230525],
        viewMode: "2D",
      });

      const geocoder = new AMap.Geocoder({ city: "全国" });
      let marker = null;

      map.on("click", (e) => {
        const lng = e.lnglat.getLng();
        const lat = e.lnglat.getLat();
        console.log("[地图选点] 经纬度:", { lng, lat });
        setSelectionUI(lng, lat, "解析中…");
        currentSelection = { lng, lat };

        if (marker) {
          map.remove(marker);
        }
        marker = new AMap.Marker({ position: [lng, lat] });
        map.add(marker);

        geocoder.getAddress([lng, lat], (status, result) => {
          if (status === "complete" && result?.info === "OK") {
            const addr =
              result.regeocode?.formattedAddress || "未知地点";
            elAddress.textContent = addr;
            console.log("[地图选点] 地名:", addr);

            const adcode = result?.regeocode?.addressComponent?.adcode;
            currentSelection = { lng, lat, address: addr, adcode };
            setChatHint("已更新选点与天气上下文。现在可以在右侧提问。");
            if (hasWeather) {
              if (!adcode) {
                setWeatherUI({
                  status: "无法获取 adcode，天气查询不可用",
                  temp: "—",
                  wind: "—",
                  humidity: "—",
                  obsTime: "—",
                });
                currentWeather = null;
                console.warn("[天气] 缺少 adcode，无法调用高德天气");
                return;
              }

              setWeatherUI({
                status: "加载中…",
                temp: "—",
                wind: "—",
                humidity: "—",
                obsTime: "—",
              });

              fetchAmapWeatherLive({ adcode })
                .then((live) => {
                  renderAmapWeatherLive(live);
                  console.log("[天气] live:", live, "adcode:", adcode);
                })
                .catch((err) => {
                  console.error("[天气] 拉取失败:", err);
                  currentWeather = null;
                  setWeatherUI({
                    status: "天气获取失败",
                    temp: "—",
                    wind: "—",
                    humidity: "—",
                    obsTime: "—",
                  });
                });
            }
          } else {
            elAddress.textContent = "逆地理编码失败，请稍后重试";
            console.warn("[地图选点] 逆地理编码失败:", status, result);
            currentSelection = { lng, lat };
            currentWeather = null;

            if (hasWeather) {
              setWeatherUI({
                status: "逆地理编码失败，无法查询天气",
                temp: "—",
                wind: "—",
                humidity: "—",
                obsTime: "—",
              });
            }
          }
        });
      });

      showHint(
        hasWeather
          ? "点击地图任意位置可选点，将显示经纬度、地名、天气。"
          : "点击地图任意位置可选点，将显示经纬度与地名（天气未配置）。",
      );
    })
    .catch((err) => {
      console.error(err);
      showHint("地图加载失败：请检查 Key、安全密钥与域名白名单配置。");
    });
}

main();
