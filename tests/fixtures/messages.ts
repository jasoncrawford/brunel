// Typed message fixtures for use in tests.

export const MSG_SYSTEM_INIT = {
  type: "system",
  subtype: "init",
  session_id: "70fb4366-b5a2-4cf2-bc13-60ec34d61aef",
  cwd: "/workspace",
  tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
};

export const MSG_ASSISTANT_THINKING = {
  type: "assistant",
  message: {
    content: [
      { type: "thinking", thinking: "Let me think about this carefully." },
    ],
  },
};

export const MSG_ASSISTANT_TEXT = {
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "Here is my response." },
    ],
  },
};

export const MSG_ASSISTANT_BASH = {
  type: "assistant",
  message: {
    content: [
      {
        type: "tool_use",
        id: "toolu_bash_001",
        name: "Bash",
        input: { command: "ls -la" },
      },
    ],
  },
};

export const MSG_ASSISTANT_READ = {
  type: "assistant",
  message: {
    content: [
      {
        type: "tool_use",
        id: "toolu_read_001",
        name: "Read",
        input: { file_path: "/workspace/src/repl.ts" },
      },
    ],
  },
};

export const MSG_ASSISTANT_EDIT = {
  type: "assistant",
  message: {
    content: [
      {
        type: "tool_use",
        id: "toolu_edit_001",
        name: "Edit",
        input: { file_path: "/workspace/src/repl.ts", old_string: "foo", new_string: "bar" },
      },
    ],
  },
};

export const MSG_USER_TOOL_RESULT_OK = {
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_bash_001",
        is_error: false,
        content: "total 8\ndrwxr-xr-x 2 node node 4096 Jan 1 00:00 .\n",
      },
    ],
  },
  tool_use_result: {},
};

export const MSG_USER_TOOL_RESULT_ERROR = {
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_bash_001",
        is_error: true,
        content: "command not found: lss",
      },
    ],
  },
  tool_use_result: {},
};

export const MSG_USER_TOOL_REFERENCE = {
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_tool_ref_001",
        is_error: false,
        content: [{ type: "tool_reference", tool_name: "Write" }],
      },
    ],
  },
  tool_use_result: {},
};

export const MSG_USER_SYNTHETIC = {
  type: "user",
  isSynthetic: true,
  message: {
    content: [
      { type: "text", text: "This is a synthetic message injected by the system." },
    ],
  },
};

export const MSG_TASK_STARTED = {
  type: "system",
  subtype: "task_started",
  description: "Running the test suite",
};

export const MSG_TASK_PROGRESS = {
  type: "system",
  subtype: "task_progress",
  description: "Processing file 1 of 3",
};

export const MSG_TASK_NOTIFICATION = {
  type: "system",
  subtype: "task_notification",
  status: "completed",
  summary: "All tests passed",
};

export const MSG_SUBAGENT = {
  type: "assistant",
  parent_tool_use_id: "toolu_agent_001",
  message: {
    content: [
      { type: "text", text: "Subagent response (should be suppressed)." },
    ],
  },
};

export const MSG_STREAM_MESSAGE_START = {
  type: "stream_event",
  parent_tool_use_id: null,
  event: {
    type: "message_start",
    message: {
      usage: { input_tokens: 500 },
    },
  },
};

export const MSG_STREAM_MESSAGE_DELTA = {
  type: "stream_event",
  parent_tool_use_id: null,
  event: {
    type: "message_delta",
    usage: { output_tokens: 77 },
  },
};

export const MSG_STREAM_MESSAGE_STOP = {
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "message_stop" },
};

export const MSG_STREAM_CONTENT_DELTA = {
  type: "stream_event",
  parent_tool_use_id: null,
  event: {
    type: "content_block_delta",
    delta: { type: "text_delta", text: "partial..." },
  },
};

export const MSG_RESULT = {
  type: "result",
  subtype: "success",
  duration_ms: 2064,
  num_turns: 1,
  usage: { input_tokens: 3, output_tokens: 77 },
  total_cost_usd: 0.12,
};

export const MSG_RATE_LIMIT = {
  type: "rate_limit_event",
  rate_limit_info: { status: "allowed" },
};
