import fs from "node:fs/promises";
import path from "node:path";
import type { CDPSession, Page } from "playwright";
import { expect } from "playwright/test";
import { it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiTerminalReady,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

type TouchPoint = {
  force: number;
  id: number;
  radiusX: number;
  radiusY: number;
  rotationAngle: number;
  x: number;
  y: number;
};

type TraceEvent = {
  clientX: number;
  clientY: number;
  isTrusted: boolean;
  pointerId: number;
  pointerType: string;
  time: number;
  type: string;
};

type UiState = {
  capturedByOwner: boolean;
  capturedByLatestPointer: boolean;
  foreignPointerId: number | null;
  latestPointerId: number | null;
  ownerPointerId: number | null;
  panelWidth: number;
  persistedWidth: number | null;
  reserveRight: string;
  touchAction: string;
  trace: TraceEvent[];
};

const candidateSha = process.env.CANDIDATE_SHA?.trim() ?? "";
const proofDir = process.env.OPENCLAW_POINTER_PROOF_DIR?.trim() ?? "";
const storageKey = "openclaw.terminal.panel.v1";
const initialWidth = 520;
const ownerDelta = 60;
const nextPointerDelta = 40;
const widthBeforeClose = initialWidth + ownerDelta;
const expectedFinalWidth = widthBeforeClose + nextPointerDelta;

const suite = createControlUiE2eSuite({
  name: "PR 118591 exact-head Chromium pointer ownership proof",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is unavailable at ${executablePath}; exact-head visual proof cannot proceed.`,
});

function touch(id: number, x: number, y: number): TouchPoint {
  return {
    force: 1,
    id,
    radiusX: 8,
    radiusY: 8,
    rotationAngle: 0,
    x,
    y,
  };
}

async function dispatchTouch(
  cdp: CDPSession,
  type: "touchEnd" | "touchMove" | "touchStart",
  touchPoints: TouchPoint[],
): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
}

async function dispatchMouse(
  cdp: CDPSession,
  type: "mouseMoved" | "mousePressed" | "mouseReleased",
  x: number,
  y: number,
): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", {
    button: type === "mouseMoved" ? "none" : "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: type === "mouseMoved" ? 0 : 1,
    pointerType: "mouse",
    type,
    x,
    y,
  });
}

async function installEvidenceOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const panel = document.querySelector("openclaw-terminal-panel");
    const resizer = panel?.shadowRoot?.querySelector<HTMLElement>(".tp-resizer");
    if (!resizer) {
      throw new Error("Terminal resizer not found in the live Control UI");
    }

    const proofWindow = window as typeof window & {
      __openclawPointerProof?: {
        record: (event: Event) => void;
        resizers: WeakSet<HTMLElement>;
        trace: TraceEvent[];
      };
    };
    const proof =
      proofWindow.__openclawPointerProof ??
      (() => {
        const trace: TraceEvent[] = [];
        const record = (rawEvent: Event) => {
          const event = rawEvent as PointerEvent;
          trace.push({
            clientX: event.clientX,
            clientY: event.clientY,
            isTrusted: event.isTrusted,
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            time: performance.now(),
            type: event.type,
          });
        };
        window.addEventListener("pointermove", record, true);
        window.addEventListener("pointerup", record, true);
        window.addEventListener("pointercancel", record, true);
        return { record, resizers: new WeakSet<HTMLElement>(), trace };
      })();
    proofWindow.__openclawPointerProof = proof;
    if (!proof.resizers.has(resizer)) {
      resizer.addEventListener("pointerdown", proof.record, true);
      resizer.addEventListener("gotpointercapture", proof.record, true);
      resizer.addEventListener("lostpointercapture", proof.record, true);
      proof.resizers.add(resizer);
    }

    if (document.querySelector("#pointer-proof-overlay")) {
      return;
    }

    const overlay = document.createElement("section");
    overlay.id = "pointer-proof-overlay";
    overlay.setAttribute("aria-label", "Pointer ownership proof status");
    overlay.innerHTML = `
      <div class="proof-kicker">OPENCLAW · REAL CHROMIUM POINTER INPUT</div>
      <div class="proof-title">Preparing pointer ownership proof…</div>
      <div class="proof-sha"></div>
      <div class="proof-lines"></div>
      <div class="proof-verdict">RUNNING</div>
    `;
    const style = document.createElement("style");
    style.textContent = `
      #pointer-proof-overlay {
        position: fixed;
        z-index: 2147483647;
        top: 20px;
        left: 20px;
        width: 430px;
        box-sizing: border-box;
        padding: 18px 20px;
        border: 1px solid rgba(255,255,255,.22);
        border-radius: 14px;
        background: rgba(9, 13, 20, .94);
        box-shadow: 0 18px 48px rgba(0,0,0,.45);
        color: #f4f7fb;
        font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
        pointer-events: none;
      }
      #pointer-proof-overlay .proof-kicker {
        color: #72d9ff;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: .11em;
      }
      #pointer-proof-overlay .proof-title {
        margin-top: 7px;
        font: 700 20px/1.25 ui-sans-serif, system-ui, sans-serif;
      }
      #pointer-proof-overlay .proof-sha {
        margin-top: 6px;
        color: #9da9b8;
        font-size: 12px;
      }
      #pointer-proof-overlay .proof-lines {
        margin-top: 12px;
        white-space: pre-line;
      }
      #pointer-proof-overlay .proof-verdict {
        display: inline-block;
        margin-top: 14px;
        padding: 4px 9px;
        border-radius: 999px;
        background: #29415a;
        color: #d7edff;
        font-size: 12px;
        font-weight: 800;
      }
      #pointer-proof-overlay[data-result="pass"] .proof-verdict {
        background: #174c35;
        color: #8ff0bd;
      }
      .pointer-proof-marker {
        position: fixed;
        z-index: 2147483646;
        width: 30px;
        height: 30px;
        transform: translate(-50%, -50%);
        border: 3px solid currentColor;
        border-radius: 50%;
        box-shadow: 0 0 0 5px rgba(0,0,0,.38);
        pointer-events: none;
      }
      .pointer-proof-marker::after {
        position: absolute;
        top: 34px;
        left: 50%;
        transform: translateX(-50%);
        padding: 3px 6px;
        border-radius: 5px;
        background: rgba(0,0,0,.82);
        color: currentColor;
        content: attr(data-label);
        font: 700 11px/1 ui-monospace, monospace;
        white-space: nowrap;
      }
      #pointer-proof-owner { color: #ffb454; }
      #pointer-proof-foreign { color: #72d9ff; }
      .pointer-proof-marker[data-ended="true"] {
        border-style: dashed;
        opacity: .58;
      }
    `;
    document.head.append(style);
    document.body.append(overlay);
    for (const [id, label] of [
      ["pointer-proof-owner", "OWNER"],
      ["pointer-proof-foreign", "FOREIGN"],
    ] as const) {
      const marker = document.createElement("div");
      marker.id = id;
      marker.className = "pointer-proof-marker";
      marker.dataset.label = label;
      marker.hidden = true;
      document.body.append(marker);
    }
  });
}

async function updateOverlay(
  page: Page,
  update: {
    foreign?: { ended: boolean; x: number; y: number };
    foreignLabel?: string;
    lines: string[];
    owner?: { ended: boolean; x: number; y: number };
    ownerLabel?: string;
    result?: "pass" | "running";
    title: string;
    verdict: string;
  },
): Promise<void> {
  await page.evaluate(
    ({ candidateSha: sha, update: next }) => {
      const overlay = document.querySelector<HTMLElement>("#pointer-proof-overlay");
      if (!overlay) {
        throw new Error("Proof overlay is missing");
      }
      const title = overlay.querySelector<HTMLElement>(".proof-title");
      const shaNode = overlay.querySelector<HTMLElement>(".proof-sha");
      const lines = overlay.querySelector<HTMLElement>(".proof-lines");
      const verdict = overlay.querySelector<HTMLElement>(".proof-verdict");
      if (!title || !shaNode || !lines || !verdict) {
        throw new Error("Proof overlay is incomplete");
      }
      title.textContent = next.title;
      shaNode.textContent = `exact HEAD ${sha}`;
      lines.textContent = next.lines.join("\n");
      verdict.textContent = next.verdict;
      overlay.dataset.result = next.result ?? "running";

      for (const [id, point, label] of [
        ["pointer-proof-owner", next.owner, next.ownerLabel],
        ["pointer-proof-foreign", next.foreign, next.foreignLabel],
      ] as const) {
        const marker = document.querySelector<HTMLElement>(`#${id}`);
        if (!marker) {
          continue;
        }
        marker.hidden = !point;
        if (point) {
          marker.style.left = `${point.x}px`;
          marker.style.top = `${point.y}px`;
          marker.dataset.ended = String(point.ended);
          if (label) {
            marker.dataset.label = label;
          }
        }
      }
    },
    { candidateSha, update },
  );
}

async function readUiState(page: Page): Promise<UiState> {
  return await page.evaluate((key) => {
    const panel = document.querySelector("openclaw-terminal-panel");
    const resizer = panel?.shadowRoot?.querySelector<HTMLElement>(".tp-resizer");
    const surface = panel?.shadowRoot?.querySelector<HTMLElement>(".tp");
    if (!panel || !resizer || !surface) {
      throw new Error("Terminal panel proof surface disappeared");
    }
    const proofWindow = window as typeof window & {
      __openclawPointerProof?: { trace: TraceEvent[] };
    };
    const trace = [...(proofWindow.__openclawPointerProof?.trace ?? [])];
    const pointerDowns = trace.filter((event) => event.type === "pointerdown");
    const ownerPointerId = pointerDowns[0]?.pointerId ?? null;
    const foreignPointerId = pointerDowns[1]?.pointerId ?? null;
    const latestPointerId = pointerDowns.at(-1)?.pointerId ?? null;
    let capturedByOwner = false;
    if (ownerPointerId !== null) {
      try {
        capturedByOwner = resizer.hasPointerCapture(ownerPointerId);
      } catch {
        capturedByOwner = false;
      }
    }
    let capturedByLatestPointer = false;
    if (latestPointerId !== null) {
      try {
        capturedByLatestPointer = resizer.hasPointerCapture(latestPointerId);
      } catch {
        capturedByLatestPointer = false;
      }
    }
    let persistedWidth: number | null = null;
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "null") as {
        width?: unknown;
      } | null;
      persistedWidth = typeof stored?.width === "number" ? stored.width : null;
    } catch {
      persistedWidth = null;
    }
    return {
      capturedByOwner,
      capturedByLatestPointer,
      foreignPointerId,
      latestPointerId,
      ownerPointerId,
      panelWidth: surface.getBoundingClientRect().width,
      persistedWidth,
      reserveRight: document.documentElement.style.getPropertyValue(
        "--oc-terminal-reserve-right",
      ),
      touchAction: getComputedStyle(resizer).touchAction,
      trace,
    };
  }, storageKey);
}

async function readPersistedLayout(
  page: Page,
): Promise<{ open: boolean | null; width: number | null }> {
  return await page.evaluate((key) => {
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "null") as {
        open?: unknown;
        width?: unknown;
      } | null;
      return {
        open: typeof stored?.open === "boolean" ? stored.open : null,
        width: typeof stored?.width === "number" ? stored.width : null,
      };
    } catch {
      return { open: null, width: null };
    }
  }, storageKey);
}

async function readTrace(page: Page): Promise<TraceEvent[]> {
  return await page.evaluate(() => {
    const proofWindow = window as typeof window & {
      __openclawPointerProof?: { trace: TraceEvent[] };
    };
    return [...(proofWindow.__openclawPointerProof?.trace ?? [])];
  });
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    path: path.join(proofDir, name),
  });
}

suite.define(() => {
  it("reopens for the next pointer while the original owner remains down", async () => {
    expect(candidateSha).toBe("174b4498e928210e59369c9b495d232942457af6");
    expect(proofDir).not.toBe("");
    await fs.mkdir(proofDir, { recursive: true });

    const context = await suite.newBrowserContext({
      colorScheme: "dark",
      hasTouch: true,
      locale: "en-US",
      recordVideo: {
        dir: path.join(proofDir, ".raw-video"),
        size: { height: 800, width: 1280 },
      },
      serviceWorkers: "block",
      viewport: { height: 800, width: 1280 },
    });
    const page = await context.newPage();
    const video = page.video();
    let result:
      | {
          browserVersion: string;
          closed: { open: boolean | null; trace: TraceEvent[]; width: number | null };
          final: UiState;
          foreignIgnored: UiState;
          initial: UiState;
          ownerResized: UiState;
          reopenedResized: UiState;
          inputCoordinates: Record<string, number>;
          userAgent: string;
        }
      | undefined;
    let failure: unknown;

    try {
      const gateway = await installMockGateway(page, {
        featureMethods: ["terminal.open"],
        historyMessages: [
          {
            content: [
              {
                type: "text",
                text: "Verify that another touch cannot hijack the terminal resize gesture.",
              },
            ],
            role: "user",
            timestamp: Date.now() - 1_000,
          },
        ],
        methodResponses: {
          "terminal.list": { sessions: [] },
          "terminal.open": {
            agentId: "main",
            confined: false,
            cwd: "/workspace/openclaw",
            sessionId: "pointer-ownership-proof",
            shell: "/bin/bash",
          },
        },
        terminalEnabled: true,
      });

      await page.goto(`${suite.server.baseUrl}activity`);
      await waitForControlUiGatewayReady(page);
      await waitForControlUiTerminalReady(page);
      await page.keyboard.press("Control+Backquote");
      await gateway.waitForRequest("terminal.open");
      await gateway.emitGatewayEvent("terminal.data", {
        data: "OpenClaw pointer ownership proof\r\n$ real Chromium touch-owner + mouse-foreign input ready\r\n$ ",
        seq: 0,
        sessionId: "pointer-ownership-proof",
      });

      const panel = page.locator("openclaw-terminal-panel");
      const surface = panel.locator(".tp");
      await panel.getByRole("button", { name: "Dock to right" }).click();
      await expect.poll(() => surface.getAttribute("class")).toContain("tp--right");
      const resizer = panel.locator(".tp-resizer");
      await expect(resizer).toBeVisible();
      const box = await resizer.boundingBox();
      expect(box).not.toBeNull();
      if (!box) {
        throw new Error("Terminal resizer has no live Chromium geometry");
      }

      await installEvidenceOverlay(page);
      const initial = await readUiState(page);
      expect(Math.round(initial.panelWidth)).toBe(initialWidth);
      expect(initial.persistedWidth).toBe(initialWidth);
      expect(initial.reserveRight).toBe(`${initialWidth}px`);
      expect(initial.touchAction).toBe("none");
      await updateOverlay(page, {
        lines: [
          `panel width       ${Math.round(initial.panelWidth)} px`,
          `persisted width   ${initial.persistedWidth} px`,
          `touch-action      ${initial.touchAction}`,
        ],
        title: "Initial terminal dock",
        verdict: "READY",
      });
      await screenshot(page, "01-initial.png");
      await page.waitForTimeout(700);

      const ownerCdpId = 41;
      const ownerX = Math.round(box.x + box.width / 2);
      const ownerY = Math.round(box.y + Math.min(180, box.height * 0.35));
      const foreignY = Math.round(Math.min(box.y + box.height - 80, ownerY + 130));
      const foreignMovedX = ownerX - 110;
      const ownerMovedX = ownerX - ownerDelta;
      const cdp = await context.newCDPSession(page);

      await dispatchTouch(cdp, "touchStart", [touch(ownerCdpId, ownerX, ownerY)]);
      await expect.poll(async () => (await readUiState(page)).ownerPointerId).not.toBeNull();
      let ownerStarted = await readUiState(page);
      expect(ownerStarted.capturedByOwner).toBe(true);
      expect(ownerStarted.trace.every((event) => event.isTrusted)).toBe(true);
      await updateOverlay(page, {
        lines: [
          `owner DOM id      ${ownerStarted.ownerPointerId}`,
          `owner capture     ACTIVE`,
          `trusted events    true`,
          `panel width       ${Math.round(ownerStarted.panelWidth)} px`,
        ],
        owner: { ended: false, x: ownerX, y: ownerY },
        title: "Owner pointer started",
        verdict: "OWNER ACTIVE",
      });
      await page.waitForTimeout(700);

      await dispatchMouse(cdp, "mousePressed", ownerX, foreignY);
      await expect.poll(async () => (await readUiState(page)).foreignPointerId).not.toBeNull();
      ownerStarted = await readUiState(page);
      expect(ownerStarted.foreignPointerId).not.toBe(ownerStarted.ownerPointerId);
      expect(
        ownerStarted.trace.find(
          (event) =>
            event.type === "pointerdown" && event.pointerId === ownerStarted.foreignPointerId,
        )?.pointerType,
      ).toBe("mouse");

      await dispatchMouse(cdp, "mouseMoved", foreignMovedX, foreignY);
      await expect
        .poll(async () => {
          const state = await readUiState(page);
          return state.trace.some(
            (event) =>
              event.type === "pointermove" &&
              event.pointerId === state.foreignPointerId &&
              event.clientX === foreignMovedX,
          );
        })
        .toBe(true);
      await dispatchMouse(cdp, "mouseReleased", foreignMovedX, foreignY);
      await expect
        .poll(async () => {
          const state = await readUiState(page);
          return state.trace.some(
            (event) => event.type === "pointerup" && event.pointerId === state.foreignPointerId,
          );
        })
        .toBe(true);

      const foreignIgnored = await readUiState(page);
      expect(foreignIgnored.capturedByOwner).toBe(true);
      expect(Math.round(foreignIgnored.panelWidth)).toBe(initialWidth);
      expect(foreignIgnored.persistedWidth).toBe(initialWidth);
      expect(foreignIgnored.reserveRight).toBe(`${initialWidth}px`);
      expect(foreignIgnored.trace.every((event) => event.isTrusted)).toBe(true);
      await updateOverlay(page, {
        foreign: { ended: true, x: foreignMovedX, y: foreignY },
        lines: [
          `foreign DOM id    ${foreignIgnored.foreignPointerId}`,
          `foreign mouse     moved -110 px then ended`,
          `panel width       ${Math.round(foreignIgnored.panelWidth)} px (UNCHANGED)`,
          `owner capture     ACTIVE`,
          `trusted events    true`,
        ],
        owner: { ended: false, x: ownerX, y: ownerY },
        title: "Foreign pointer ignored",
        verdict: "WIDTH UNCHANGED",
      });
      await screenshot(page, "02-foreign-ignored.png");
      await page.waitForTimeout(900);

      await dispatchTouch(cdp, "touchMove", [touch(ownerCdpId, ownerMovedX, ownerY)]);
      await expect
        .poll(async () => {
          const state = await readUiState(page);
          return state.trace.some(
            (event) =>
              event.type === "pointermove" &&
              event.pointerId === state.ownerPointerId &&
              event.clientX === ownerMovedX,
          );
        })
        .toBe(true);
      await expect.poll(async () => (await readUiState(page)).reserveRight).toBe("580px");

      const ownerResized = await readUiState(page);
      expect(ownerResized.capturedByOwner).toBe(true);
      expect(Math.round(ownerResized.panelWidth)).toBe(widthBeforeClose);
      expect(ownerResized.persistedWidth).toBe(initialWidth);
      expect(ownerResized.trace.every((event) => event.isTrusted)).toBe(true);
      await updateOverlay(page, {
        foreign: { ended: true, x: foreignMovedX, y: foreignY },
        lines: [
          `owner moved       -${ownerDelta} px`,
          `panel width       ${Math.round(ownerResized.panelWidth)} px`,
          `persisted width   ${ownerResized.persistedWidth} px (until close)`,
          `owner capture     ACTIVE`,
          `trusted events    true`,
        ],
        owner: { ended: false, x: ownerMovedX, y: ownerY },
        title: "Owner resized before close",
        verdict: "OWNER STILL DOWN",
      });
      await screenshot(page, "03-owner-resized.png");
      await page.waitForTimeout(900);

      await panel.getByRole("button", { name: "Hide terminal" }).click();
      await expect(surface).toHaveCount(0);
      await expect.poll(async () => (await readPersistedLayout(page)).open).toBe(false);
      await expect.poll(async () => (await readPersistedLayout(page)).width).toBe(widthBeforeClose);
      await expect
        .poll(async () => {
          const trace = await readTrace(page);
          return trace.some(
            (event) =>
              event.type === "lostpointercapture" &&
              event.pointerId === ownerResized.ownerPointerId,
          );
        })
        .toBe(true);
      const closedLayout = await readPersistedLayout(page);
      const closedTrace = await readTrace(page);
      expect(closedTrace.every((event) => event.isTrusted)).toBe(true);
      const closed = { ...closedLayout, trace: closedTrace };
      await updateOverlay(page, {
        foreign: { ended: true, x: foreignMovedX, y: foreignY },
        lines: [
          `panel             CLOSED`,
          `persisted width   ${closed.width} px`,
          `old capture       RELEASED`,
          `old touch         STILL PHYSICALLY DOWN`,
        ],
        owner: { ended: false, x: ownerMovedX, y: ownerY },
        title: "Closed during owner touch",
        verdict: "OWNERSHIP CLEARED",
      });
      await screenshot(page, "04-closed-owner-still-down.png");
      await page.waitForTimeout(900);

      await page.keyboard.press("Control+Backquote");
      await expect(resizer).toBeVisible();
      await installEvidenceOverlay(page);
      const reopened = await readUiState(page);
      expect(Math.round(reopened.panelWidth)).toBe(widthBeforeClose);
      expect(reopened.persistedWidth).toBe(widthBeforeClose);
      expect(reopened.capturedByOwner).toBe(false);

      const reopenedBox = await resizer.boundingBox();
      expect(reopenedBox).not.toBeNull();
      if (!reopenedBox) {
        throw new Error("Reopened terminal resizer has no live Chromium geometry");
      }
      const nextPointerX = Math.round(reopenedBox.x + reopenedBox.width / 2);
      const nextPointerY = Math.round(
        reopenedBox.y + Math.min(230, reopenedBox.height * 0.45),
      );
      const nextPointerMovedX = nextPointerX - nextPointerDelta;

      await dispatchMouse(cdp, "mouseMoved", nextPointerX, nextPointerY);
      await dispatchMouse(cdp, "mousePressed", nextPointerX, nextPointerY);
      await expect
        .poll(async () => {
          const state = await readUiState(page);
          return state.trace.filter((event) => event.type === "pointerdown").length;
        })
        .toBe(3);
      const nextPointerStarted = await readUiState(page);
      expect(nextPointerStarted.latestPointerId).not.toBe(nextPointerStarted.ownerPointerId);
      expect(nextPointerStarted.capturedByLatestPointer).toBe(true);

      await dispatchMouse(cdp, "mouseMoved", nextPointerMovedX, nextPointerY);
      await expect.poll(async () => (await readUiState(page)).reserveRight).toBe("620px");
      const reopenedResized = await readUiState(page);
      expect(Math.round(reopenedResized.panelWidth)).toBe(expectedFinalWidth);
      expect(reopenedResized.persistedWidth).toBe(widthBeforeClose);
      expect(reopenedResized.capturedByLatestPointer).toBe(true);
      expect(reopenedResized.trace.every((event) => event.isTrusted)).toBe(true);
      await updateOverlay(page, {
        foreign: { ended: false, x: nextPointerMovedX, y: nextPointerY },
        foreignLabel: "NEXT",
        lines: [
          `old owner DOM id  ${reopenedResized.ownerPointerId} (still down)`,
          `next DOM id       ${reopenedResized.latestPointerId} (captured)`,
          `next moved        -${nextPointerDelta} px`,
          `panel width       ${Math.round(reopenedResized.panelWidth)} px`,
          `persisted width   ${reopenedResized.persistedWidth} px (until next end)`,
        ],
        owner: { ended: false, x: ownerMovedX, y: ownerY },
        title: "Next pointer resized immediately",
        verdict: "NO STALE OWNER BLOCK",
      });
      await screenshot(page, "05-reopened-next-pointer-resized.png");
      await page.waitForTimeout(900);

      await dispatchMouse(cdp, "mouseReleased", nextPointerMovedX, nextPointerY);
      await expect
        .poll(async () => (await readUiState(page)).capturedByLatestPointer)
        .toBe(false);
      await expect
        .poll(async () => (await readUiState(page)).persistedWidth)
        .toBe(expectedFinalWidth);

      // End the original touch only after the reopened panel's next pointer has
      // completed and persisted its resize.
      await dispatchTouch(cdp, "touchEnd", []);
      await page.waitForTimeout(250);

      const final = await readUiState(page);
      expect(Math.round(final.panelWidth)).toBe(expectedFinalWidth);
      expect(final.persistedWidth).toBe(expectedFinalWidth);
      expect(final.reserveRight).toBe(`${expectedFinalWidth}px`);
      expect(final.touchAction).toBe("none");
      expect(final.trace.every((event) => event.isTrusted)).toBe(true);
      await updateOverlay(page, {
        foreign: { ended: true, x: nextPointerMovedX, y: nextPointerY },
        foreignLabel: "NEXT",
        lines: [
          `old owner DOM id  ${final.ownerPointerId} (ended last)`,
          `next DOM id       ${final.latestPointerId} (ended first)`,
          `final width       ${Math.round(final.panelWidth)} px`,
          `persisted width   ${final.persistedWidth} px`,
          `next capture      RELEASED`,
          `all pointer events isTrusted=true`,
        ],
        owner: { ended: true, x: ownerMovedX, y: ownerY },
        result: "pass",
        title: "Close/reopen ownership reset",
        verdict: "PASS",
      });
      await screenshot(page, "06-final-pass.png");
      await page.waitForTimeout(1_100);

      result = {
        browserVersion: suite.browser.version(),
        closed,
        final,
        foreignIgnored,
        initial,
        ownerResized,
        reopenedResized,
        inputCoordinates: {
          foreignMovedX,
          foreignY,
          nextPointerMovedX,
          nextPointerX,
          nextPointerY,
          ownerCdpId,
          ownerMovedX,
          ownerX,
          ownerY,
        },
        userAgent: await page.evaluate(() => navigator.userAgent),
      };
    } catch (error) {
      failure = error;
      await page
        .screenshot({
          animations: "disabled",
          caret: "hide",
          path: path.join(proofDir, "failure.png"),
        })
        .catch(() => {});
    }

    await suite.closeBrowserContext(context);
    if (!video) {
      failure ??= new Error("Playwright did not create a proof recording");
    } else {
      try {
        await video.saveAs(path.join(proofDir, "pointer-ownership-proof.webm"));
        await video.delete();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) {
      throw failure;
    }
    if (!result) {
      throw new Error("Pointer ownership proof completed without evidence state");
    }

    const evidence = {
      schema: "openclaw-control-ui-pointer-ownership-proof-v2",
      candidateSha,
      generatedAt: new Date().toISOString(),
      github: {
        repository: process.env.GITHUB_REPOSITORY ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        runId: process.env.GITHUB_RUN_ID ?? null,
        workflowSha: process.env.GITHUB_SHA ?? null,
      },
      environment: {
        browser: `Chromium ${result.browserVersion}`,
        mockedGateway: true,
        source:
          "Input.dispatchTouchEvent (original owner) + Input.dispatchMouseEvent (foreign and post-reopen pointer) through one Chromium CDP session",
        userAgent: result.userAgent,
        viewport: { height: 800, width: 1280 },
      },
      assertions: {
        closePersistedOwnerWidth:
          result.closed.open === false && result.closed.width === widthBeforeClose,
        closeReleasedOriginalCapture: result.closed.trace.some(
          (event) =>
            event.type === "lostpointercapture" &&
            event.pointerId === result.ownerResized.ownerPointerId,
        ),
        finalNextPointerCaptureReleased: !result.final.capturedByLatestPointer,
        finalOriginalOwnerCaptureReleased: !result.final.capturedByOwner,
        finalWidthPersisted: result.final.persistedWidth === expectedFinalWidth,
        foreignEndDidNotReleaseOwnerCapture: result.foreignIgnored.capturedByOwner,
        foreignMoveDidNotChangePanelWidth:
          Math.round(result.foreignIgnored.panelWidth) === initialWidth,
        nextPointerAcceptedAfterReopen:
          result.reopenedResized.capturedByLatestPointer &&
          result.reopenedResized.latestPointerId !== result.reopenedResized.ownerPointerId,
        nextPointerResizedBeforeOriginalTouchEnded:
          Math.round(result.reopenedResized.panelWidth) === expectedFinalWidth,
        nextPointerWaitedToPersistUntilItsOwnEnd:
          result.reopenedResized.persistedWidth === widthBeforeClose,
        originalOwnerResizedBeforeClose:
          Math.round(result.ownerResized.panelWidth) === widthBeforeClose,
        pointerEventsAreTrusted: result.final.trace.every((event) => event.isTrusted),
        touchActionNone: result.final.touchAction === "none",
      },
      cdpInputs: {
        foreign: "mouse:left",
        inputSequence: [
          "original touch start",
          "foreign mouse move/end",
          "original touch resize",
          "Hide terminal click",
          "Ctrl+Backquote reopen",
          "next mouse resize/end",
          "original touch end",
        ],
        nextPointerAfterReopen: "mouse:left",
        ownerTouchPointId: result.inputCoordinates.ownerCdpId,
      },
      domPointerIds: {
        foreign: result.final.foreignPointerId,
        nextAfterReopen: result.final.latestPointerId,
        originalOwner: result.final.ownerPointerId,
      },
      widths: {
        closedPersisted: result.closed.width,
        finalPanel: Math.round(result.final.panelWidth),
        finalPersisted: result.final.persistedWidth,
        foreignIgnoredPanel: Math.round(result.foreignIgnored.panelWidth),
        foreignIgnoredPersisted: result.foreignIgnored.persistedWidth,
        initialPanel: Math.round(result.initial.panelWidth),
        initialPersisted: result.initial.persistedWidth,
        ownerBeforeClosePanel: Math.round(result.ownerResized.panelWidth),
        ownerBeforeClosePersisted: result.ownerResized.persistedWidth,
        reopenedNextPointerPanel: Math.round(result.reopenedResized.panelWidth),
        reopenedNextPointerPersisted: result.reopenedResized.persistedWidth,
      },
      eventTrace: result.final.trace,
      artifacts: [
        "01-initial.png",
        "02-foreign-ignored.png",
        "03-owner-resized.png",
        "04-closed-owner-still-down.png",
        "05-reopened-next-pointer-resized.png",
        "06-final-pass.png",
        "pointer-ownership-proof.webm",
      ],
    };
    expect(Object.values(evidence.assertions).every(Boolean)).toBe(true);
    await fs.writeFile(
      path.join(proofDir, "evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
  });
});
