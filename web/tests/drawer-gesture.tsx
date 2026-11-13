import React from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "../src/layout/AppShell";
import { I18nProvider } from "../src/i18n";
import "../src/index.css";

// Minimal AppShell harness for the mobile drawer gesture regression suite.
// The real app supplies FileTree/SessionList content; here plain scrollable
// columns are enough to exercise the touch engine and its scroller exemptions.

const items = Array.from({ length: 40 }, (_, index) => `item-${index}`);

function Fixture() {
  const [leftOpen, setLeftOpen] = React.useState(false);
  const [rightOpen, setRightOpen] = React.useState(false);
  return (
    <I18nProvider>
      <AppShell
        leftOpen={leftOpen}
        rightOpen={rightOpen}
        onCloseLeft={() => setLeftOpen(false)}
        onCloseRight={() => setRightOpen(false)}
        onOpenLeft={() => setLeftOpen(true)}
        onOpenRight={() => setRightOpen(true)}
        sidebar={
          <div data-testid="left-body" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ height: 44, flexShrink: 0 }}>left header</div>
            <div data-testid="left-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 8px" }}>
              {items.map((item) => (
                <div key={item} style={{ height: 32 }}>{item}</div>
              ))}
            </div>
          </div>
        }
        rightSidebar={
          <div data-testid="right-body" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div
              data-testid="chips"
              style={{ display: "flex", gap: 8, overflowX: "auto", overflowY: "hidden", flexShrink: 0, padding: "6px 8px" }}
            >
              {Array.from({ length: 16 }, (_, index) => (
                <span key={index} style={{ flex: "0 0 auto", padding: "4px 12px", border: "1px solid #ccc", borderRadius: 999 }}>chip-{index}</span>
              ))}
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 8px" }}>
              {items.map((item) => (
                <div key={item} style={{ height: 32 }}>session-{item}</div>
              ))}
            </div>
          </div>
        }
        main={
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <div
              data-testid="code"
              style={{ marginLeft: 12, marginTop: 40, overflowX: "auto", overflowY: "hidden", whiteSpace: "pre", padding: 8, height: 360 }}
            >
              {"const veryLongIdentifier = '" + "x".repeat(600) + "';\n".repeat(12)}
            </div>
            <textarea
              data-testid="composer"
              defaultValue="selectable composer text"
              style={{ marginLeft: 12, marginTop: 12, width: 280, height: 64 }}
            />
            <div style={{ height: 1600 }} />
          </div>
        }
        footer={
          <div style={{ display: "flex", gap: 8, padding: 6, width: "100%" }}>
            <button type="button" aria-label="toggle-left" style={{ width: 30, height: 44 }} onClick={() => setLeftOpen((value) => !value)}>
              L
            </button>
            <button type="button" aria-label="toggle-right" style={{ width: 30, height: 44, marginLeft: "auto" }} onClick={() => setRightOpen((value) => !value)}>
              R
            </button>
          </div>
        }
      />
      <output
        data-testid="state"
        data-left={leftOpen ? "open" : "closed"}
        data-right={rightOpen ? "open" : "closed"}
        style={{ position: "fixed", left: 0, top: 0 }}
      />
    </I18nProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
