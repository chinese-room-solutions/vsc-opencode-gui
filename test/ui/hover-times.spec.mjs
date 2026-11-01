// Hover chips carry run windows, and every carrier is a status circle:
// message dots, thinking phase dots, notice dots, tool dots — one chip per
// circle, placed a bit up and right of it by the same offset (an invisible
// ::before inflates the 7-8px targets). User rows show their send moment
// as text beside the hover actions instead. Shapes, not stamps: the seed's
// T0 is the fake server process's Date.now(), not the spec's.
import { test, expect } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

const ENV = {
  OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
  OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
  OPENCODE_DIALECT: "v2",
  OPENCODE_READY_SOUND: "0",
  OPENCODE_PERMISSION_SOUND: "0",
  OPENCODE_QUESTION_SOUND: "0",
};

const CLOCK = "\\d{2}:\\d{2}:\\d{2}";

// Rendered ::after geometry of a carrier: left/bottom offsets, transform
// tx, and the full box width (content + padding + border).
async function chip(page, el) {
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const a = getComputedStyle(node, "::after");
    const m = a.transform.match(
      /matrix\(([-\d.e]+), ([-\d.e]+), ([-\d.e]+), ([-\d.e]+), ([-\d.e]+), ([-\d.e]+)\)/,
    );
    const full =
      parseFloat(a.width) +
      parseFloat(a.paddingLeft) +
      parseFloat(a.paddingRight) +
      parseFloat(a.borderLeftWidth) +
      parseFloat(a.borderRightWidth);
    return {
      content: a.content,
      left: parseFloat(a.left),
      bottom: parseFloat(a.bottom),
      tx: m ? parseFloat(m[5]) : a.transform === "none" ? 0 : null,
      full,
      rect: { l: r.left, rt: r.right },
    };
  });
}

// The one placement contract: the chip starts ~4px right of the circle's
// right edge, and its bottom clears the circle's top by ~6px.
async function expectUpRight(page, el, g) {
  const b = await el.boundingBox();
  const chipL = g.rect.l + g.left;
  expect(chipL).toBeGreaterThanOrEqual(b.x + b.width + 3.5);
  expect(chipL).toBeLessThanOrEqual(b.x + b.width + 4.5);
  expect(g.bottom).toBeGreaterThanOrEqual(b.height + 5.5);
  expect(g.bottom).toBeLessThanOrEqual(b.height + 6.5);
}

test("every circle carries its times in one chip", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);

    // A settled bash card (start→end fixed at 5.2s in the seed): window
    // plus elapsed span, on the TOOL DOT.
    const bash = page.locator(".tool").filter({
      has: page.locator(".tool-pill", { hasText: "npm run compile" }),
    });
    await expect(bash).toHaveCount(1, { timeout: 15_000 });
    await expect(bash.locator(".tool-dot")).toHaveAttribute(
      "data-tip",
      new RegExp(`^${CLOCK} → ${CLOCK} · 5s$`),
    );

    // The explore fold's head dot: first start → last end, plus the
    // run's span (fixed at 1.3s in the seed).
    await expect(page.locator(".explore-head .tool-dot")).toHaveAttribute(
      "data-tip",
      new RegExp(`^${CLOCK} → ${CLOCK} · 1s$`),
    );

    // An assistant turn (seed: created → completed 4s later): the DOT
    // carries the window plus duration.
    await expect(page.locator(".msg.assistant .dot").first()).toHaveAttribute(
      "data-tip",
      new RegExp(`^${CLOCK} → ${CLOCK} · 4s$`),
    );

    // User rows have no circle and no chip — their hover shows the time
    // beside the actions instead (below).
    await expect(page.locator(".msg.user").first()).not.toHaveAttribute(
      "data-tip",
    );
  } finally {
    rig.stop();
  }
});

test("message dot and tool dot place the chip by the same up-right offset", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    const scroller = await page
      .locator(".msgs")
      .evaluate((el) => el.getBoundingClientRect().right);

    // The transcript culls offscreen rows' rendering — the bottom turn's
    // dot is the one on screen at load (the first() dot is a hidden
    // offscreen row; its attribute is still asserted in the other test).
    const dot = page.locator(".msg.assistant .dot").last();
    await dot.waitFor({ timeout: 15_000 });
    await dot.scrollIntoViewIfNeeded();
    const db = await dot.boundingBox();
    await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
    const g = await chip(page, dot);
    expect(g.content).toMatch(new RegExp(`^\"${CLOCK} → ${CLOCK} · 4s\"$`));
    expect(g.tx).not.toBeNull();
    await expectUpRight(page, dot, g);
    expect(g.rect.l + g.left + g.full).toBeLessThanOrEqual(scroller + 0.5);
    expect(g.rect.l + g.left).toBeGreaterThanOrEqual(0);

    // The tool dot: same offset, same shape — the uniformity the design
    // asks for.
    const bashDot = page
      .locator(".tool")
      .filter({
        has: page.locator(".tool-pill", { hasText: "npm run compile" }),
      })
      .locator(".tool-dot");
    await bashDot.scrollIntoViewIfNeeded();
    const tb = await bashDot.boundingBox();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    const t = await chip(page, bashDot);
    expect(t.content).toMatch(new RegExp(`^\"${CLOCK} → ${CLOCK} · 5s\"$`));
    await expectUpRight(page, bashDot, t);

    // A user row states its send moment on hover, left of the copy
    // button, under the pill — riding the actions' reveal.
    const user = page.locator(".msg.user").first();
    await user.scrollIntoViewIfNeeded();
    const ub = await user.boundingBox();
    await page.mouse.move(ub.x + ub.width / 2, ub.y + ub.height / 2);
    await page.waitForTimeout(250);
    const time = user.locator(".msg-actions .act-time");
    await expect(time).toHaveText(new RegExp(`^${CLOCK}$`));
    const order = await user.evaluate((el) => {
      const t = el.querySelector(".msg-actions .act-time");
      const b = el.querySelector(".msg-actions .msg-action");
      const rt = t.getBoundingClientRect();
      const rb2 = b.getBoundingClientRect();
      return {
        timeRight: rt.right,
        btnLeft: rb2.left,
        timeTop: rt.top,
        pillBottom: el.querySelector(".user-pill").getBoundingClientRect().bottom,
        opacity: getComputedStyle(t.parentElement).opacity,
      };
    });
    expect(order.timeRight).toBeLessThanOrEqual(order.btnLeft);
    expect(order.timeTop).toBeGreaterThanOrEqual(order.pillBottom - 1);
    expect(Number(order.opacity)).toBeGreaterThanOrEqual(0.9);
  } finally {
    rig.stop();
  }
});
