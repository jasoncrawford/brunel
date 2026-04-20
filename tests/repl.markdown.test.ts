import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stripAnsi } from "./helpers.js";
import { getConfig } from "../src/config.js";
import { Display } from "../src/agent/views/display.js";
import { AgentStatus } from "../src/agent/models/agent-status.js";

let testDisplay: Display;

function captureOutput(fn: () => void): string {
  let output = "";
  vi.spyOn(console, "log").mockImplementation((s: any) => { output += String(s) + "\n"; });
  fn();
  vi.restoreAllMocks();
  return output;
}

function printText(text: string): string {
  return captureOutput(() => {
    testDisplay.printBlock({ type: "text", text }, "assistant");
  });
}

const setColumns = (n: number | undefined) => {
  testDisplay.getColumns = () => n;
};

beforeEach(() => {
  testDisplay = new Display(getConfig(), new AgentStatus({ agentId: "test-agent" }));
  testDisplay.stopBar();
  getConfig().verbose = false;
});

afterEach(() => {
  testDisplay.stopBar();
  getConfig().verbose = false;
  vi.restoreAllMocks();
});

describe("mdInline", () => {
  it("bold with **", () => {
    const output = printText("**bold**");
    expect(stripAnsi(output)).toContain("bold");
    expect(output).toContain("\x1b[1m");
  });

  it("bold with __", () => {
    const output = printText("__bold__");
    expect(stripAnsi(output)).toContain("bold");
    expect(output).toContain("\x1b[1m");
  });

  it("inline code: bold+underline applied", () => {
    const output = printText("`code`");
    expect(stripAnsi(output)).toContain("code");
    expect(output).toContain("\x1b[1m");
    expect(output).toContain("\x1b[4m");
  });

  it("multiple bold occurrences", () => {
    const output = printText("**a** and **b**");
    expect(stripAnsi(output)).toContain("a and b");
    const boldCount = (output.match(/\x1b\[1m/g) ?? []).length;
    expect(boldCount).toBe(2);
  });

  it("no markdown passes through unchanged", () => {
    const output = printText("plain text");
    expect(stripAnsi(output)).toContain("plain text");
    expect(output).not.toContain("\x1b[1m");
  });

  it("unclosed ** passes through unchanged", () => {
    const output = printText("**unclosed");
    expect(stripAnsi(output)).toContain("**unclosed");
  });

  it("strikethrough passes through as-is", () => {
    const output = printText("~~strike~~");
    expect(stripAnsi(output)).toContain("~~strike~~");
  });

  it("italic passes through as-is", () => {
    const output = printText("*italic*");
    expect(stripAnsi(output)).toContain("*italic*");
  });
});

describe("renderMarkdown - plain text", () => {
  it("non-markdown line passed through", () => {
    expect(stripAnsi(printText("just text"))).toContain("just text");
  });

  it("empty string renders without content", () => {
    expect(stripAnsi(printText("")).trim()).toBe("");
  });
});

describe("renderMarkdown - headings", () => {
  it("H1 is uppercased and bold", () => {
    const output = printText("# Hello World");
    expect(stripAnsi(output)).toContain("HELLO WORLD");
    expect(output).toContain("\x1b[1m");
  });

  it("H2 is bold but not uppercased", () => {
    const output = printText("## Section");
    expect(stripAnsi(output)).toContain("Section");
    expect(stripAnsi(output)).not.toContain("SECTION");
    expect(output).toContain("\x1b[1m");
  });

  it("H3 is bold but not uppercased", () => {
    const output = printText("### Sub");
    expect(stripAnsi(output)).toContain("Sub");
    expect(stripAnsi(output)).not.toContain("SUB");
    expect(output).toContain("\x1b[1m");
  });
});

describe("renderMarkdown - blockquotes", () => {
  it("> quoted text → ▏ prefix", () => {
    expect(stripAnsi(printText("> quoted text"))).toContain("▏ quoted text");
  });

  it("nested blockquote gets single ▏ prefix", () => {
    expect(stripAnsi(printText("> > inner"))).toContain("▏ > inner");
  });
});

describe("renderMarkdown - lists", () => {
  it("- item → • item", () => {
    expect(stripAnsi(printText("- item"))).toContain("• item");
  });

  it("* item → • item", () => {
    expect(stripAnsi(printText("* item"))).toContain("• item");
  });

  it("+ item → • item", () => {
    expect(stripAnsi(printText("+ item"))).toContain("• item");
  });

  it("indented list item preserves indentation", () => {
    expect(stripAnsi(printText("  - indented"))).toContain("  • indented");
  });

  it("ordered list: 1. stays as-is", () => {
    expect(stripAnsi(printText("1. ordered"))).toContain("1. ordered");
  });

  it("ordered list: 2. stays as-is", () => {
    expect(stripAnsi(printText("2. second"))).toContain("2. second");
  });

  it("indented ordered list preserves indentation", () => {
    expect(stripAnsi(printText("  1. indented ordered"))).toContain("  1. indented ordered");
  });
});

describe("renderMarkdown - code blocks", () => {
  it("code block lines get 2-space indent, fences omitted", () => {
    expect(stripAnsi(printText("```\ncode\n```"))).toContain("  code");
  });

  it("language tag stripped", () => {
    expect(stripAnsi(printText("```ts\nconst x = 1;\n```"))).toContain("  const x = 1;");
  });

  it("multi-line code block each line indented", () => {
    const result = stripAnsi(printText("```\nline1\nline2\n```"));
    expect(result).toContain("  line1");
    expect(result).toContain("  line2");
  });

  it("backtick fences not in output", () => {
    expect(stripAnsi(printText("```\ncode\n```"))).not.toContain("```");
  });

  it("code content not processed by mdInline", () => {
    const output = printText("```\n**not bold**\n```");
    expect(output).not.toContain("\x1b[1m");
    expect(stripAnsi(output)).toContain("**not bold**");
  });

  it("unclosed code block: remaining lines get 2-space indent", () => {
    const result = stripAnsi(printText("```\nline1\nline2"));
    expect(result).toContain("  line1");
    expect(result).toContain("  line2");
  });
});

describe("renderMarkdown - horizontal rules", () => {
  it("--- renders as ─ repeated W times", () => {
    expect(stripAnsi(printText("---"))).toContain("─".repeat(70));
  });

  it("*** renders as rule", () => {
    expect(stripAnsi(printText("***"))).toContain("─".repeat(70));
  });

  it("___ renders as rule", () => {
    expect(stripAnsi(printText("___"))).toContain("─".repeat(70));
  });

  it("---- (4+ dashes) renders as rule", () => {
    expect(stripAnsi(printText("----"))).toContain("─".repeat(70));
  });

  it("-- (only 2 chars) does NOT render as rule", () => {
    expect(stripAnsi(printText("-- "))).not.toContain("─".repeat(70));
  });
});

describe("renderMarkdown - tables", () => {
  const tableInput = `| Name | Age |\n| --- | --- |\n| Alice | 30 |`;

  it("table renders with │ borders", () => {
    expect(stripAnsi(printText(tableInput))).toContain("│");
  });

  it("separator row replaced with divider ├─...─┤", () => {
    const result = stripAnsi(printText(tableInput));
    expect(result).toContain("├─");
    expect(result).toContain("─┤");
  });

  it("table data rows rendered", () => {
    const result = stripAnsi(printText(tableInput));
    expect(result).toContain("Alice");
    expect(result).toContain("30");
  });

  it("table at end of input (no trailing newline) still rendered", () => {
    const result = stripAnsi(printText("| A | B |\n| --- | --- |\n| 1 | 2 |"));
    expect(result).toContain("│");
    expect(result).toContain("1");
  });

  it("single-column table renders", () => {
    const result = stripAnsi(printText("| Col |\n| --- |\n| val |"));
    expect(result).toContain("│");
    expect(result).toContain("val");
  });
});

describe("renderTable - text wrapping", () => {

  it("table that fits within maxWidth is not wrapped", () => {
    setColumns(80);
    const tableMarkdown = "| A | B |\n| --- | --- |\n| short | text |";
    const result = stripAnsi(printText(tableMarkdown));
    const outputLines = result.split("\n").filter(l => l.startsWith("│") || l.startsWith("├"));
    expect(outputLines).toHaveLength(3); // header, divider, data row
  });

  it("each output line fits within maxWidth when wrapping needed", () => {
    setColumns(60);
    const tableMarkdown = "| Bug | Root cause | Fix |\n| --- | --- | --- |\n| Short | A very long root cause explanation that exceeds the column width significantly | Short fix |";
    const result = stripAnsi(printText(tableMarkdown));
    for (const line of result.split("\n").filter(Boolean)) {
      if (line.startsWith("│") || line.startsWith("├")) {
        expect(line.length).toBeLessThanOrEqual(60);
      }
    }
  });

  it("all cell content is preserved after wrapping", () => {
    setColumns(40);
    const tableMarkdown = "| Col A | Col B |\n| --- | --- |\n| short | this is a very long text that will need to be wrapped across multiple lines in the output |";
    const result = stripAnsi(printText(tableMarkdown));
    expect(result).toContain("short");
    expect(result).toContain("this is a very long text");
    expect(result).toContain("multiple lines");
  });

  it("divider line fits within maxWidth", () => {
    setColumns(50);
    const tableMarkdown = "| Bug | Root cause | Fix |\n| --- | --- | --- |\n| Short | Very long root cause text that needs wrapping here | Short |";
    const result = stripAnsi(printText(tableMarkdown));
    const dividerLine = result.split("\n").find(l => l.startsWith("├"));
    expect(dividerLine).toBeDefined();
    expect(dividerLine!.length).toBeLessThanOrEqual(50);
  });

  it("short columns keep natural width when only wide column wraps", () => {
    setColumns(40);
    const tableMarkdown = "| Name | Description |\n| ---- | ----------- |\n| Alice | A very long description that should wrap to multiple lines in the output |";
    const result = stripAnsi(printText(tableMarkdown));
    expect(result).toContain("Alice");
    expect(result).toContain("A very long");
  });

  it("wrapped row has │ borders on every output line", () => {
    setColumns(25);
    const tableMarkdown = "| A | B |\n| - | - |\n| x | this is a long cell that wraps |";
    const result = stripAnsi(printText(tableMarkdown));
    const dataLines = result.split("\n").filter(l => l.startsWith("│"));
    expect(dataLines.length).toBeGreaterThan(1);
    for (const line of dataLines) {
      expect(line).toMatch(/^│.*│$/);
    }
  });
});

describe("renderTable - inline formatting column widths", () => {

  it("all rows have equal visible column widths when mixing bold and plain cells", () => {
    setColumns(80);
    const tableMarkdown = "| Name | Status |\n| --- | --- |\n| **Alice** | active |\n| Bob | inactive |";
    const result = printText(tableMarkdown);
    const rowLines = stripAnsi(result).split("\n").filter(l => l.startsWith("│"));
    const lengths = rowLines.map(l => l.length);
    expect(lengths.every(l => l === lengths[0])).toBe(true);
  });

  it("bold cell renders with ANSI bold codes in output", () => {
    setColumns(80);
    const tableMarkdown = "| Name |\n| --- |\n| **Alice** |";
    const output = printText(tableMarkdown);
    expect(output).toContain("\x1b[1m");
    expect(stripAnsi(output)).toContain("Alice");
  });

  it("inline code in table cell renders with bold+underline", () => {
    setColumns(80);
    const tableMarkdown = "| Command |\n| --- |\n| `git status` |";
    const output = printText(tableMarkdown);
    expect(output).toContain("\x1b[1m");
    expect(output).toContain("\x1b[4m");
    expect(stripAnsi(output)).toContain("git status");
  });

  it("column width reflects visible length not raw markdown length", () => {
    setColumns(80);
    const tableMarkdown = "| Col |\n| --- |\n| **bold** |";
    const result = stripAnsi(printText(tableMarkdown));
    expect(result).toContain("bold");
    expect(result).toContain("├──────┤");
    expect(result).toContain("│ bold │");
  });

  it("plain text rows still align with formatted rows", () => {
    setColumns(80);
    const tableMarkdown = "| Name | Status |\n| --- | --- |\n| **Alice** | active |\n| Bob | inactive |";
    const result = stripAnsi(printText(tableMarkdown));
    const rowLines = result.split("\n").filter(l => l.startsWith("│"));
    const lastPipe = rowLines.map(l => l.lastIndexOf("│"));
    expect(lastPipe.every(p => p === lastPipe[0])).toBe(true);
  });
});

describe("renderMarkdown - mixed content", () => {
  it("heading + paragraph + list all rendered", () => {
    const result = stripAnsi(printText("# Title\n\nSome text.\n\n- item1\n- item2"));
    expect(result).toContain("TITLE");
    expect(result).toContain("Some text.");
    expect(result).toContain("• item1");
    expect(result).toContain("• item2");
  });

  it("code block interior not processed as markdown", () => {
    const result = stripAnsi(printText("# Heading\n\n```\n# not a heading\n```\n\nafter"));
    expect(result).toContain("HEADING");
    expect(result).toContain("  # not a heading");
    expect(result).toContain("after");
  });

  it("table followed by paragraph: table flushed, paragraph continues", () => {
    const result = stripAnsi(printText("| A |\n| - |\n| 1 |\n\nParagraph after"));
    expect(result).toContain("│");
    expect(result).toContain("Paragraph after");
  });
});
