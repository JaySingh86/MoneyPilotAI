import { describe, expect, it } from "vitest";
import { HTML_LIMITS, htmlToText, styleHidesContent } from "./html.js";

const t = (html: string) => htmlToText(html).text;

describe("htmlToText: visible content", () => {
  it("keeps amounts and dates and separates table cells", () => {
    const out = t(
      "<table><tr><td>Premium</td><td>$684.00</td></tr><tr><td>Due</td><td>November 4, 2026</td></tr></table>",
    );
    expect(out).toContain("Premium $684.00");
    expect(out).toContain("Due November 4, 2026");
  });

  it("keeps link text but drops hrefs and images", () => {
    const out = t(
      '<a href="https://x.example/pay?token=SECRET">Pay your bill</a><img src="https://x.example/p.gif" alt="pixel">',
    );
    expect(out).toContain("Pay your bill");
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("pixel");
  });

  it("decodes entities and survives malformed markup", () => {
    expect(t("<p>Tom &amp; Jerry &lt;b&gt; $5&nbsp;off<p>unclosed <b>bold")).toContain("Tom & Jerry <b>");
    expect(() => t("<<<>>>&&&<div<div>")).not.toThrow();
  });

  it("does not let text re-open tags (text with angle brackets stays text)", () => {
    expect(t("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>")).toContain("<script>alert(1)</script>");
  });
});

describe("htmlToText: hidden text is removed", () => {
  const hiddenStyles = [
    "display:none",
    "display: none !important",
    "visibility:hidden",
    "opacity:0",
    "font-size:0",
    "font-size: 0px",
    "max-height:0;overflow:hidden",
    "mso-hide:all",
    "color:transparent",
    "text-indent:-9999px",
    "position:absolute;left:-9999px",
    "color:#fff;background-color:#ffffff",
    "color:white;background:white",
    "clip:rect(0,0,0,0)",
  ];
  it.each(hiddenStyles)("style %s", (style) => {
    const out = t(`<p>Visible $10.00</p><div style="${style}">HIDDEN-INSTRUCTION</div>`);
    expect(out).toContain("Visible $10.00");
    expect(out).not.toContain("HIDDEN-INSTRUCTION");
  });

  it("attributes, classes, tags and comments", () => {
    const out = t(`
      <p>Visible</p>
      <div hidden>H1</div><span aria-hidden="true">H2</span><div class="preheader">H3</div>
      <div class="x Visually-Hidden">H4</div><!-- H5 --><script>H6</script><style>H7{}</style>
      <noscript>H8</noscript><template>H9</template><title>H10</title><textarea>H11</textarea>
      <svg><text>H12</text></svg>`);
    expect(out).toContain("Visible");
    for (let i = 1; i <= 12; i++) expect(out).not.toContain(`H${i}`);
  });

  it("hides the whole subtree and resumes afterwards", () => {
    const out = t('<div style="display:none"><p>A<b>B</b></p><div>C</div></div><p>after</p>');
    expect(out).toBe("after");
  });

  it("does not hide normal styled text", () => {
    expect(t('<p style="color:#333;font-size:14px;opacity:0.9">Shown</p>')).toBe("Shown");
    expect(styleHidesContent("font-size:10px")).toBe(false);
  });
});

describe("htmlToText: classes hidden by a <style> block", () => {
  it("hides elements whose class the stylesheet hides", () => {
    const out = t(
      `<html><head><style>.secret { display: none !important } .a, .tiny{font-size:0} .keep{color:#333}</style></head>
       <body><p class="keep">Shown $5.00</p><p class="secret">H1</p><span class="x tiny">H2</span></body></html>`,
    );
    expect(out).toContain("Shown $5.00");
    expect(out).not.toContain("H1");
    expect(out).not.toContain("H2");
  });

  it("ignores rules inside @media (they apply only on some screens)", () => {
    const out = t(
      `<style>@media (max-width:600px){.desktop{display:none}}</style><p class="desktop">Visible</p>`,
    );
    expect(out).toContain("Visible");
  });

  it("only simple class selectors count; a huge stylesheet is capped", () => {
    const css =
      ".c" +
      "x".repeat(10) +
      "{display:none}".repeat(1) +
      " p{display:none}" +
      ".z{color:red}".repeat(20_000);
    const out = t(`<style>${css}</style><p>Para</p><p class="cxxxxxxxxxx">gone</p>`);
    expect(out).toContain("Para");
  });
});

describe("htmlToText: hostile input", () => {
  it("deep nesting does not overflow the stack and keeps earlier content", () => {
    const html = "<p>Amount due $5.00</p>" + "<div>".repeat(20_000) + "deep" + "</div>".repeat(20_000);
    const r = htmlToText(html);
    expect(r.text).toContain("Amount due $5.00");
  });

  it("drops anything past the depth limit instead of recursing", () => {
    const depth = HTML_LIMITS.maxDepth + 20;
    const out = t("<div>".repeat(depth) + "TOO-DEEP" + "</div>".repeat(depth));
    expect(out).not.toContain("TOO-DEEP");
  });

  it("caps huge input and flags truncation", () => {
    const html = "<p>x</p>".repeat(400_000);
    const r = htmlToText(html);
    expect(r.truncated).toBe(true);
  });

  it("handles a million tiny elements quickly", () => {
    const start = performance.now();
    htmlToText("<i>a</i>".repeat(200_000));
    expect(performance.now() - start).toBeLessThan(10_000);
  });
});
