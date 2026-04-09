function escapeHtml(value) {
  return (value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function api(path, options) {
  const res = await fetch(path, options);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Ошибка");
  return json;
}

function widgetCode(widget, host) {
  return `<iframe
  src="${host}/embed/${widget.id}"
  width="100%"
  height="760"
  style="border:0;display:block;"
  loading="lazy">
</iframe>`;
}

async function loadCabinet() {
  const meEmail = document.getElementById("me-email");
  const widgetsList = document.getElementById("widgets-list");
  const createForm = document.getElementById("create-widget-form");
  const createMsg = document.getElementById("create-msg");
  const logoutBtn = document.getElementById("logout-btn");
  const host = window.location.origin;

  let me;
  try {
    me = await api("/api/me");
  } catch (_error) {
    window.location.href = "/auth";
    return;
  }

  meEmail.textContent = `Вы вошли как: ${me.email}`;

  async function renderWidgets() {
    const data = await api("/api/my-widgets");
    if (!data.widgets.length) {
      widgetsList.innerHTML = '<p class="muted">Пока нет виджетов. Создайте первый выше.</p>';
      return;
    }
    widgetsList.innerHTML = data.widgets
      .map((widget) => {
        const paidLabel =
          widget.billingCycle === "yearly"
            ? "Paid годовой (без пометки)"
            : "Paid помесячный (без пометки)";
        const status = widget.plan === "paid" ? paidLabel : "Free (с пометкой)";
        const code = widgetCode(widget, host);
        const payActions =
          widget.plan === "paid"
            ? '<p class="muted">Тариф активен до: ' + escapeHtml(widget.activeUntil || "не указано") + "</p>"
            : `<div class="actions">
                <button class="btn btn--primary" data-pay-monthly="${widget.id}">Оплатить 300 ₽/мес</button>
                <button class="btn btn--primary" data-pay-yearly="${widget.id}">Оплатить 3000 ₽/год</button>
              </div>`;
        return `<article class="card" style="margin-top:10px">
          <h3>@${escapeHtml(widget.channel)}</h3>
          <p class="muted">Статус: <strong>${status}</strong></p>
          <p class="muted">Код вставки:</p>
          <textarea class="code-output" readonly>${escapeHtml(code)}</textarea>
          <div class="actions">
            <button class="btn btn--ghost" data-copy="${widget.id}">Скопировать код</button>
          </div>
          ${payActions}
        </article>`;
      })
      .join("");

    widgetsList.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", async () => {
        const widgetId = button.getAttribute("data-copy");
        const widget = data.widgets.find((w) => w.id === widgetId);
        if (!widget) return;
        const code = widgetCode(widget, host);
        await navigator.clipboard.writeText(code);
        button.textContent = "Скопировано";
        setTimeout(() => (button.textContent = "Скопировать код"), 1000);
      });
    });

    async function payFor(widgetId, tariff, button) {
      button.disabled = true;
      try {
        const checkout = await api(`/api/my-widgets/${widgetId}/checkout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tariff })
        });
        if (!checkout.checkoutUrl) {
          throw new Error("Не удалось получить ссылку оплаты");
        }
        window.location.href = checkout.checkoutUrl;
      } catch (error) {
        alert(error.message);
      } finally {
        button.disabled = false;
      }
    }

    widgetsList.querySelectorAll("[data-pay-monthly]").forEach((button) => {
      button.addEventListener("click", async () => {
        const widgetId = button.getAttribute("data-pay-monthly");
        await payFor(widgetId, "monthly", button);
      });
    });

    widgetsList.querySelectorAll("[data-pay-yearly]").forEach((button) => {
      button.addEventListener("click", async () => {
        const widgetId = button.getAttribute("data-pay-yearly");
        await payFor(widgetId, "yearly", button);
      });
    });
  }

  createForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(createForm).entries());
    createMsg.textContent = "Создаю...";
    try {
      await api("/api/my-widgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      createForm.reset();
      createMsg.textContent = "Виджет создан";
      await renderWidgets();
    } catch (error) {
      createMsg.textContent = error.message;
    }
  });

  logoutBtn.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    window.location.href = "/auth";
  });

  await renderWidgets();
}

loadCabinet();
