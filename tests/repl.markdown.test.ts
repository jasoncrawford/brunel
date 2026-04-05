import { describe, it, expect } from "vitest";
import { stripAnsi } from "./helpers.js";
import { mdInline, renderMarkdown, renderTable, s } from "../src/agent/display.js";

describe("mdInline", () => {
  it("bold with **", () => {
    const result = mdInline("**bold**");
    expect(stripAnsi(result)).toBe("bold");
    expect(result).toContain("\x1b[1m");
  });

  it("bold with __", () => {
    const result = mdInline("__bold__");
    expect(stripAnsi(result)).toBe("bold");
    expect(result).toContain("\x1b[1m");
  });

  it("inline code: bold+underline applied", () => {
    const result = mdInline("`code`");
    expect(stripAnsi(result)).toBe("code");
    expect(result).toContain("\x1b[1m");
    expect(result).toContain("\x1b[4m");
  });

  it("multiple bold occurrences", () => {
    const result = stripAnsi(mdInline("**a** and **b**"));
    expect(result).toBe("a and b");
    const raw = mdInline("**a** and **b**");
    // Both 'a' and 'b' should be bolded (two bold escape sequences)
    const boldCount = (raw.match(/\x1b\[1m/g) ?? []).length;
    expect(boldCount).toBe(2);
  });

  it("no markdown passes through unchanged", () => {
    expect(mdInline("plain text")).toBe("plain text");
  });

  it("unclosed ** passes through unchanged", () => {
    expect(mdInline("**unclosed")).toBe("**unclosed");
  });

  it("strikethrough passes through as-is", () => {
    expect(mdInline("~~strike~~")).toBe("~~strike~~");
  });

  it("italic passes through as-is", () => {
    expect(mdInline("*italic*")).toBe("*italic*");
  });
});

describe("renderMarkdown - plain text", () => {
  it("non-markdown line passed through", () => {
    const result = stripAnsi(renderMarkdown("just text"));
    expect(result).toBe("just text");
  });

  it("empty string returns empty string", () => {
    expect(renderMarkdown("")).toBe("");
  });
});

describe("renderMarkdown - headings", () => {
  it("H1 is uppercased and bold", () => {
    const result = renderMarkdown("# Hello World");
    const plain = stripAnsi(result);
    expect(plain).toBe("HELLO WORLD");
    expect(result).toContain("\x1b[1m");
  });

  it("H2 is bold but not uppercased", () => {
    const result = renderMarkdown("## Section");
    const plain = stripAnsi(result);
    expect(plain).toBe("Section");
    expect(result).toContain("\x1b[1m");
  });

  it("H3 is bold but not uppercased", () => {
    const result = renderMarkdown("### Sub");
    const plain = stripAnsi(result);
    expect(plain).toBe("Sub");
    expect(result).toContain("\x1b[1m");
  });
});

describe("renderMarkdown - blockquotes", () => {
  it("> quoted text → ▏ prefix", () => {
    const result = stripAnsi(renderMarkdown("> quoted text"));
    expect(result).toBe("▏ quoted text");
  });

  it("nested blockquote gets single ▏ prefix", () => {
    const result = stripAnsi(renderMarkdown("> > inner"));
    expect(result).toBe("▏ > inner");
  });
});

describe("renderMarkdown - lists", () => {
  it("- item → • item", () => {
    expect(stripAnsi(renderMarkdown("- item"))).toBe("• item");
  });

  it("* item → • item", () => {
    expect(stripAnsi(renderMarkdown("* item"))).toBe("• item");
  });

  it("+ item → • item", () => {
    expect(stripAnsi(renderMarkdown("+ item"))).toBe("• item");
  });

  it("indented list item preserves indentation", () => {
    expect(stripAnsi(renderMarkdown("  - indented"))).toBe("  • indented");
  });

  it("ordered list: 1. stays as-is", () => {
    expect(stripAnsi(renderMarkdown("1. ordered"))).toBe("1. ordered");
  });

  it("ordered list: 2. stays as-is", () => {
    expect(stripAnsi(renderMarkdown("2. second"))).toBe("2. second");
  });

  it("indented ordered list preserves indentation", () => {
    expect(stripAnsi(renderMarkdown("  1. indented ordered"))).toBe("  1. indented ordered");
  });
});

describe("renderMarkdown - code blocks", () => {
  it("code block lines get 2-space indent, fences omitted", () => {
    const result = stripAnsi(renderMarkdown("```\ncode\n```"));
    expect(result).toBe("  code");
  });

  it("language tag stripped", () => {
    const result = stripAnsi(renderMarkdown("```ts\nconst x = 1;\n```"));
    expect(result).toBe("  const x = 1;");
  });

  it("multi-line code block each line indented", () => {
    const result = stripAnsi(renderMarkdown("```\nline1\nline2\n```"));
    expect(result).toBe("  line1\n  line2");
  });

  it("backtick fences not in output", () => {
    const result = stripAnsi(renderMarkdown("```\ncode\n```"));
    expect(result).not.toContain("```");
  });

  it("code content not processed by mdInline", () => {
    const result = renderMarkdown("```\n**not bold**\n```");
    // The content should not have bold ANSI codes
    expect(result).not.toContain("\x1b[1m");
    expect(stripAnsi(result)).toContain("**not bold**");
  });

  it("unclosed code block: remaining lines get 2-space indent", () => {
    const result = stripAnsi(renderMarkdown("```\nline1\nline2"));
    expect(result).toBe("  line1\n  line2");
  });
});

describe("renderMarkdown - horizontal rules", () => {
  it("--- renders as ─ repeated W times", () => {
    const result = stripAnsi(renderMarkdown("---"));
    expect(result).toBe("─".repeat(70));
  });

  it("*** renders as rule", () => {
    const result = stripAnsi(renderMarkdown("***"));
    expect(result).toBe("─".repeat(70));
  });

  it("___ renders as rule", () => {
    const result = stripAnsi(renderMarkdown("___"));
    expect(result).toBe("─".repeat(70));
  });

  it("---- (4+ dashes) renders as rule", () => {
    const result = stripAnsi(renderMarkdown("----"));
    expect(result).toBe("─".repeat(70));
  });

  it("-- (only 2 chars) does NOT render as rule", () => {
    const result = stripAnsi(renderMarkdown("-- "));
    expect(result).not.toBe("─".repeat(70));
  });
});

describe("renderMarkdown - tables", () => {
  const tableInput = `| Name | Age |\n| --- | --- |\n| Alice | 30 |`;

  it("table renders with │ borders", () => {
    const result = stripAnsi(renderMarkdown(tableInput));
    expect(result).toContain("│");
  });

  it("separator row replaced with divider ├─...─┤", () => {
    const result = stripAnsi(renderMarkdown(tableInput));
    expect(result).toContain("├─");
    expect(result).toContain("─┤");
  });

  it("table data rows rendered", () => {
    const result = stripAnsi(renderMarkdown(tableInput));
    expect(result).toContain("Alice");
    expect(result).toContain("30");
  });

  it("table at end of input (no trailing newline) still rendered", () => {
    const result = stripAnsi(renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |"));
    expect(result).toContain("│");
    expect(result).toContain("1");
  });

  it("single-column table renders", () => {
    const result = stripAnsi(renderMarkdown("| Col |\n| --- |\n| val |"));
    expect(result).toContain("│");
    expect(result).toContain("val");
  });
});

describe("renderTable - text wrapping", () => {
  it("table that fits within maxWidth is not wrapped", () => {
    const lines = [
      "| A | B |",
      "| --- | --- |",
      "| short | text |",
    ];
    const result = stripAnsi(renderTable(lines, 80));
    const outputLines = result.split("\n");
    expect(outputLines).toHaveLength(3); // header, divider, data row
  });

  it("each output line fits within maxWidth when wrapping needed", () => {
    const lines = [
      "| Bug | Root cause | Fix |",
      "| --- | --- | --- |",
      "| Short | A very long root cause explanation that exceeds the column width significantly | Short fix |",
    ];
    const result = stripAnsi(renderTable(lines, 60));
    for (const line of result.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it("all cell content is preserved after wrapping", () => {
    const lines = [
      "| Col A | Col B |",
      "| --- | --- |",
      "| short | this is a very long text that will need to be wrapped across multiple lines in the output |",
    ];
    const result = stripAnsi(renderTable(lines, 40));
    // All words from the long cell should appear somewhere in the output
    expect(result).toContain("short");
    expect(result).toContain("this is a very long text");
    expect(result).toContain("multiple lines");
  });

  it("divider line fits within maxWidth", () => {
    const lines = [
      "| Bug | Root cause | Fix |",
      "| --- | --- | --- |",
      "| Short | Very long root cause text that needs wrapping here | Short |",
    ];
    const result = stripAnsi(renderTable(lines, 50));
    const dividerLine = result.split("\n").find(l => l.startsWith("├"));
    expect(dividerLine).toBeDefined();
    expect(dividerLine!.length).toBeLessThanOrEqual(50);
  });

  it("short columns keep natural width when only wide column wraps", () => {
    const lines = [
      "| Name | Description |",
      "| ---- | ----------- |",
      "| Alice | A very long description that should wrap to multiple lines in the output |",
    ];
    const result = stripAnsi(renderTable(lines, 40));
    expect(result).toContain("Alice");
    expect(result).toContain("A very long");
  });

  it("wrapped row has │ borders on every output line", () => {
    const lines = [
      "| A | B |",
      "| - | - |",
      "| x | this is a long cell that wraps |",
    ];
    const result = stripAnsi(renderTable(lines, 25));
    const dataLines = result.split("\n").filter(l => l.startsWith("│"));
    // There should be more than one data line because of wrapping
    expect(dataLines.length).toBeGreaterThan(1);
    for (const line of dataLines) {
      expect(line).toMatch(/^│.*│$/);
    }
  });
});

describe("renderTable - inline formatting column widths", () => {
  it("all rows have equal visible column widths when mixing bold and plain cells", () => {
    // **Alice** is 9 raw chars but 5 visible; Bob is 3 visible
    // Both columns should render with the same width (max visible = 5)
    const lines = [
      "| Name | Status |",
      "| --- | --- |",
      "| **Alice** | active |",
      "| Bob | inactive |",
    ];
    const result = renderTable(lines, 80);
    const rowLines = stripAnsi(result).split("\n").filter(l => l.startsWith("│"));
    const lengths = rowLines.map(l => l.length);
    expect(lengths.every(l => l === lengths[0])).toBe(true);
  });

  it("bold cell renders with ANSI bold codes in output", () => {
    const lines = [
      "| Name |",
      "| --- |",
      "| **Alice** |",
    ];
    const result = renderTable(lines, 80);
    expect(result).toContain("\x1b[1m");
    expect(stripAnsi(result)).toContain("Alice");
  });

  it("inline code in table cell renders with bold+underline", () => {
    const lines = [
      "| Command |",
      "| --- |",
      "| `git status` |",
    ];
    const result = renderTable(lines, 80);
    expect(result).toContain("\x1b[1m");
    expect(result).toContain("\x1b[4m");
    expect(stripAnsi(result)).toContain("git status");
  });

  it("column width reflects visible length not raw markdown length", () => {
    // A table with only one formatted cell; column width should equal
    // the visible length of **bold** (4), not the raw length (9)
    // Header "Col" is 3 chars, so column width = max(3, 4) = 4
    const lines = [
      "| Col |",
      "| --- |",
      "| **bold** |",
    ];
    const result = stripAnsi(renderTable(lines, 80));
    expect(result).toContain("bold");
    // Divider for width=4: "├─" + "────" + "─┤" = "├──────┤"
    expect(result).toContain("├──────┤");
    // Data row for "bold" padded to 4: "│ bold │" (no extra spaces)
    expect(result).toContain("│ bold │");
  });

  it("plain text rows still align with formatted rows", () => {
    const lines = [
      "| Name | Status |",
      "| --- | --- |",
      "| **Alice** | active |",
      "| Bob | inactive |",
    ];
    const result = stripAnsi(renderTable(lines, 80));
    const rowLines = result.split("\n").filter(l => l.startsWith("│"));
    // Each row must end with │ at the same position
    const lastPipe = rowLines.map(l => l.lastIndexOf("│"));
    expect(lastPipe.every(p => p === lastPipe[0])).toBe(true);
  });
});

describe("renderMarkdown - mixed content", () => {
  it("heading + paragraph + list all rendered", () => {
    const input = "# Title\n\nSome text.\n\n- item1\n- item2";
    const result = stripAnsi(renderMarkdown(input));
    expect(result).toContain("TITLE");
    expect(result).toContain("Some text.");
    expect(result).toContain("• item1");
    expect(result).toContain("• item2");
  });

  it("code block interior not processed as markdown", () => {
    const input = "# Heading\n\n```\n# not a heading\n```\n\nafter";
    const result = stripAnsi(renderMarkdown(input));
    expect(result).toContain("HEADING");
    expect(result).toContain("  # not a heading");
    expect(result).toContain("after");
  });

  it("table followed by paragraph: table flushed, paragraph continues", () => {
    const input = "| A |\n| - |\n| 1 |\n\nParagraph after";
    const result = stripAnsi(renderMarkdown(input));
    expect(result).toContain("│");
    expect(result).toContain("Paragraph after");
  });
});
