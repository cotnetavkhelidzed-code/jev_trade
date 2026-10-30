import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import Header from "../src/components/Header/Header";
import type { ConnectionState, Meta } from "../src/lib/types";
import { BASE_BLOCK, WALLET, WEB, cleanup, ev, meta, render, run } from "./helpers";

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

function view(m: Meta | null, connection: ConnectionState = "live", latest = ev(BASE_BLOCK)) {
  const r = render(<Header meta={m} latest={latest} connection={connection} />);
  const button = () => r.$("button") as HTMLButtonElement;
  const badge = () => r.$(".badge") as HTMLElement | null;
  return { r, button, badge };
}

describe.skipIf(!WEB)("Header", () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  });

  test("brand and block number", () => {
    const { r } = view(meta());
    expect(r.$(".brand")?.textContent).toBe("‖ Jev Trader");
    expect(r.$(".block")?.textContent).toBe("block 105,488,269");
  });

  test("no data yet: block '-', connecting, dry-run pill disabled, no model badge", () => {
    const { r, button, badge } = view(null, "connecting", null as never);
    expect(r.$(".block")?.textContent).toBe("block -");
    expect(r.$(".offline")?.textContent).toBe("connecting");
    expect(button().textContent).toBe("dry run");
    expect(button().disabled).toBe(true);
    expect(button().title).toBe("no wallet, dry run");
    expect(button().getAttribute("aria-label")).toBe("Dry run");
    expect(badge()).toBeNull();
  });

  test("live is silent: no connection label", () => {
    const { r } = view(meta(), "live");
    expect(r.$(".offline")).toBeNull();
  });

  test("reconnecting shows a static label", () => {
    const { r } = view(meta(), "reconnecting");
    const label = r.$(".offline") as HTMLElement;
    expect(label.textContent).toBe("reconnecting");
    expect(label.getAttribute("style")).toBeNull();
  });

  test("real wallet: shortened address, full address in title and aria-label", () => {
    const { button } = view(meta());
    expect(button().textContent).toBe("0x7F3a…9C4e");
    expect(button().disabled).toBe(false);
    expect(button().title).toBe(WALLET);
    expect(button().getAttribute("aria-label")).toBe(`Copy wallet address ${WALLET}`);
  });

  test("dry run (no wallet): the pill says dry run", () => {
    const { button } = view(meta({ wallet: null, dryRun: true, model: "mock" }));
    expect(button().textContent).toBe("dry run");
    expect(button().disabled).toBe(true);
  });

  test("clicking a disabled dry-run pill does nothing", () => {
    const { button } = view(meta({ wallet: null, dryRun: true }));
    run(() => button().click());
    expect(button().textContent).toBe("dry run");
  });

  test("click copies the full address and flashes 'copied' for 1.2s", () => {
    const writeText = mock((_: string) => Promise.resolve());
    setClipboard({ writeText });
    const { button } = view(meta());
    run(() => button().click());
    expect(writeText).toHaveBeenCalledWith(WALLET);
    expect(button().textContent).toBe("copied");
    run(() => jest.advanceTimersByTime(1199));
    expect(button().textContent).toBe("copied");
    run(() => jest.advanceTimersByTime(1));
    expect(button().textContent).toBe("0x7F3a…9C4e");
  });

  test("a second click restarts the 1.2s flash", () => {
    setClipboard({ writeText: () => Promise.resolve() });
    const { button } = view(meta());
    run(() => button().click());
    run(() => jest.advanceTimersByTime(1000));
    run(() => button().click());
    run(() => jest.advanceTimersByTime(1000));
    expect(button().textContent).toBe("copied");
    run(() => jest.advanceTimersByTime(200));
    expect(button().textContent).toBe("0x7F3a…9C4e");
    expect(jest.getTimerCount()).toBe(0);
  });

  test("still flashes when the clipboard API is missing", () => {
    setClipboard(undefined);
    const { button } = view(meta());
    run(() => button().click());
    expect(button().textContent).toBe("copied");
  });

  test("still flashes when writeText throws synchronously", () => {
    setClipboard({
      writeText: () => {
        throw new Error("denied");
      },
    });
    const { button } = view(meta());
    run(() => button().click());
    expect(button().textContent).toBe("copied");
  });

  test("a rejected writeText is swallowed", async () => {
    let rejected = false;
    setClipboard({
      writeText: () =>
        Promise.reject(new Error("denied")).catch((e) => {
          rejected = true;
          throw e;
        }),
    });
    const { button } = view(meta());
    run(() => button().click());
    jest.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    expect(rejected).toBe(true);
    expect(button().textContent).toBe("copied");
  });

  test("unmount during the flash clears its timer", () => {
    setClipboard({ writeText: () => Promise.resolve() });
    const { r, button } = view(meta());
    run(() => button().click());
    expect(jest.getTimerCount()).toBe(1);
    r.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("real Jev model: jev badge colours", () => {
    for (const model of ["jev-latest", "Jev-7", "JEV"]) {
      const { badge, r } = view(meta({ model }));
      expect(badge()?.textContent).toBe(model);
      expect(badge()?.style.background).toBe("var(--badge-jev-bg)");
      expect(badge()?.style.color).toBe("var(--badge-jev-fg)");
      r.unmount();
    }
  });

  test("stand-in (mock) model: stand-in badge colours", () => {
    for (const model of ["mock", "gpt-stand-in", "not-jev"]) {
      const { badge, r } = view(meta({ model }));
      expect(badge()?.textContent).toBe(model);
      expect(badge()?.style.background).toBe("var(--badge-standin-bg)");
      expect(badge()?.style.color).toBe("var(--badge-standin-fg)");
      r.unmount();
    }
  });

  test("an empty model name renders no badge", () => {
    const { badge } = view(meta({ model: "" }));
    expect(badge()).toBeNull();
  });
});
