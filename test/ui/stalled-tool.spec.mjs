// A tool running with no argument at all is the stall signature — v2
// streams tool args as ephemeral deltas, and a stalled provider stream
// leaves the part "running" with empty input for minutes (observed
// 20-30+ on GLM). The wait reads as the transcript's standard
// "Waiting for the model..." placeholder row inside the live turn —
// under the turn's rows, above its meta footer — the same shape it
// always shows, never a line inside the tool card.
// It only appears once the arg stream has been silent 30s: a refresh
// wipes the streamed preview while the stream is healthy, and that
// alone must not read as a stall. FAKE_API_STALLED seeds the shape: a
// busy session whose live turn carries an edit part with {} input and a
// start stamp minutes old. Normal rows keep their pills.
import { test, expect } from "./support/fixture.mjs";
import { startRig } from "./support/rig.mjs";

const ENV = {
  OPENCODE_ROUTE: JSON.stringify({ view: "session", id: "ses_seed_1" }),
  OPENCODE_TABS: JSON.stringify(["ses_seed_1"]),
  OPENCODE_DIALECT: "v2",
  OPENCODE_READY_SOUND: "0",
  OPENCODE_PERMISSION_SOUND: "0",
  OPENCODE_QUESTION_SOUND: "0",
  FAKE_API_STALLED: "1",
};

// The transcript-level placeholder: a dot+label row below the turns,
// not any line inside a tool card.
const waitRow = (page) =>
  page.locator(".status-line .thinking-line", {
    hasText: "Waiting for the model",
  });

test("a stalled tool reads waiting for the model on the standard placeholder after 30s", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    // The stalled part is the live turn's last one — the transcript's
    // final tool card.
    const stalled = page.locator(".tool").last();
    await expect(stalled.locator(".tool-name")).toHaveText("Edit", {
      timeout: 15_000,
    });
    // The wait reads on the standard placeholder row under the turn's
    // rows and ABOVE its meta footer; the card itself stays one line
    // with its empty argument pill.
    await expect(waitRow(page)).toBeVisible({ timeout: 10_000 });
    await expect(stalled.locator(".thinking-line")).toHaveCount(0);
    await expect(stalled.locator(".tool-pill")).toHaveText("");
    const waitAboveFooter = await page.evaluate(() => {
      const row = [...document.querySelectorAll(".thinking-line")].find((el) =>
        el.textContent.includes("Waiting for the model"),
      );
      const foot = row?.closest(".turn")?.querySelector(".turn-footer");
      if (!row || !foot) return "missing";
      return row.compareDocumentPosition(foot) &
        Node.DOCUMENT_POSITION_FOLLOWING
        ? "before"
        : "after";
    });
    expect(waitAboveFooter).toBe("before");
    // Settled rows keep their argument pill — the hint is only for the
    // running-and-silent shape.
    const settled = page
      .locator(".tool", { hasText: "src/main.ts" })
      .first();
    await expect(settled.locator(".tool-name")).toHaveText("Edit");
    await expect(settled.locator(".tool-pill")).toHaveText("src/main.ts");
  } finally {
    rig.stop();
  }
});

test("a wiped preview with the arg stream alive does not read as a stall", async ({ page }) => {
  const rig = await startRig({ env: ENV });
  try {
    await page.goto(rig.url);
    await expect(waitRow(page)).toBeVisible({ timeout: 15_000 });
    // A delta lands: the stream is alive, so the placeholder leaves —
    // even though the durable {} input strips the streamed text from
    // the part (the pill can't rebuild; aliveness rides the delta's
    // arrival).
    await fetch(`${rig.api}/__control/argdelta`);
    await expect(waitRow(page)).toHaveCount(0, { timeout: 5_000 });
    // Drop the SSE stream: the pump reconnects and the resync re-pulls
    // the durable {} copy. With the last delta recent, the old
    // start-anchored rule would re-fire the wait within its 1s tick —
    // it must stay gone while the stream is merely between chunks.
    const conns = async () =>
      (await (await fetch(`${rig.api}/__control/eventconns`)).json())
        .connections;
    const beforeConns = await conns();
    await fetch(`${rig.api}/__control/ssedrop`);
    await expect.poll(conns, { timeout: 10_000 }).toBeGreaterThan(beforeConns);
    await page.waitForTimeout(2_500);
    await expect(waitRow(page)).toHaveCount(0);
  } finally {
    rig.stop();
  }
});
