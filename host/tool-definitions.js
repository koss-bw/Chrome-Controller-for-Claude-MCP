// The 33 chrome-controller-mcp tool definitions, extracted as data so both
// the standard stdio MCP server (host/mcp-server.js) and the codemode +
// hybrid servers can register them without duplicating the schemas.
//
// Each entry is { name, description, paramShape } where paramShape is the
// object literal of zod values passed to McpServer.tool(). Wrapping it in
// z.object(paramShape) yields the full input schema.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const TOOLS = [
  {
    name: "tabs_context_mcp",
    description:
      "List the browser tabs you can work with. Call this with NO arguments before any browser automation: it reports every open tab across the user's windows and, as `currentTab`, the one the user is actually looking at. It does not open, close, or rearrange anything. Work in `currentTab` unless told otherwise — do not assume the first tab in the list is the right one, and do not create a tab just to have a fresh one. Tabs marked `openedByYou` are ones you opened in this session. Only pass newWindow: true when the user explicitly asks for a new browser window.",
    paramShape: {
      newWindow: z
        .boolean()
        .optional()
        .describe(
          "Defaults to false. Set true ONLY when the user explicitly asks for a separate browser window: opens one and reports its tab as currentTab."
        )
    }
  },
  {
    name: "tabs_create_mcp",
    description:
      "Create a new empty tab in the window the user is working in. Use this only when the user asks for a new tab, or when the task genuinely needs an extra one — by default do the work in the tab tabs_context_mcp reports as currentTab. Tabs you create here are the only tabs you may close later.",
    paramShape: {
      newWindow: z
        .boolean()
        .optional()
        .describe(
          "Defaults to false. Set true ONLY when the user explicitly asks to open a new browser window."
        )
    }
  },
  {
    name: "tabs_close_mcp",
    description:
      "Close one or more tabs. The tab is actually removed from the browser — this is the only correct way to close a tab. Do NOT use navigate to 'about:blank' to 'close' a tab; that just navigates it to a blank page and leaves it open. By default you may only close tabs YOU opened (`openedByYou` in tabs_context_mcp); the user's own tabs are refused, because closing one can destroy work. If the user explicitly asks for one of their tabs to be closed, retry with force: true.",
    paramShape: {
      tabId: z
        .number()
        .optional()
        .describe(
          "Single tab ID to close. Use tabs_context_mcp if you don't have a valid tab ID."
        ),
      tabIds: z
        .array(z.number())
        .optional()
        .describe(
          "Optional batch form: an array of tab IDs to close in one call. Use either `tabId` or `tabIds`, not both."
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Defaults to false. Set true ONLY to close a tab the user opened, and ONLY after the user has explicitly asked for that tab to be closed. Never set this to get past a refusal on your own initiative."
        )
    }
  },
  {
    name: "navigate",
    description:
      "Navigate to a URL, or go forward/back in browser history. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      url: z
        .string()
        .describe(
          'The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.'
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID to navigate. Any open tab. Use tabs_context_mcp first if you don't have a valid tab ID; prefer the tab it reports as currentTab."
        )
    }
  },
  {
    name: "computer",
    description:
      "Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.\n* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
    paramShape: {
      action: z
        .enum([
          "left_click",
          "right_click",
          "double_click",
          "triple_click",
          "type",
          "screenshot",
          "wait",
          "scroll",
          "key",
          "left_click_drag",
          "zoom",
          "scroll_to",
          "hover"
        ])
        .describe(
          "The action to perform:\n* `left_click`: Click the left mouse button at the specified coordinates.\n* `right_click`: Click the right mouse button at the specified coordinates to open context menus.\n* `double_click`: Double-click the left mouse button at the specified coordinates.\n* `triple_click`: Triple-click the left mouse button at the specified coordinates.\n* `type`: Type a string of text.\n* `screenshot`: Take a screenshot of the screen.\n* `wait`: Wait for a specified number of seconds.\n* `scroll`: Scroll up, down, left, or right at the specified coordinates.\n* `key`: Press a specific keyboard key.\n* `left_click_drag`: Drag from start_coordinate to coordinate.\n* `zoom`: Take a screenshot of a specific region for closer inspection.\n* `scroll_to`: Scroll an element into view using its element reference ID from read_page or find tools.\n* `hover`: Move the mouse cursor to the specified coordinates or element without clicking. Useful for revealing tooltips, dropdown menus, or triggering hover states."
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID to execute the action on. Any open tab. Use tabs_context_mcp first if you don't have a valid tab ID; prefer the tab it reports as currentTab."
        ),
      coordinate: z
        .array(z.number())
        .min(2)
        .max(2)
        .optional()
        .describe(
          "(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for `left_click`, `right_click`, `double_click`, `triple_click`, and `scroll`. For `left_click_drag`, this is the end position."
        ),
      duration: z
        .number()
        .min(0)
        .max(30)
        .optional()
        .describe(
          "The number of seconds to wait. Required for `wait`. Maximum 30 seconds."
        ),
      modifiers: z
        .string()
        .optional()
        .describe(
          'Modifier keys for click actions. Supports: "ctrl", "shift", "alt", "cmd" (or "meta"), "win" (or "windows"). Can be combined with "+" (e.g., "ctrl+shift", "cmd+alt"). Optional.'
        ),
      ref: z
        .string()
        .optional()
        .describe(
          'Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Required for `scroll_to` action. Can be used as alternative to `coordinate` for click actions.'
        ),
      region: z
        .array(z.number())
        .min(4)
        .max(4)
        .optional()
        .describe(
          "(x0, y0, x1, y1): The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom` action. Useful for inspecting small UI elements like icons, buttons, or text."
        ),
      repeat: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "Number of times to repeat the key sequence. Only applicable for `key` action. Must be a positive integer between 1 and 100. Default is 1. Useful for navigation tasks like pressing arrow keys multiple times."
        ),
      scroll_direction: z
        .enum(["up", "down", "left", "right"])
        .optional()
        .describe("The direction to scroll. Required for `scroll`."),
      scroll_amount: z
        .number()
        .min(1)
        .max(10)
        .optional()
        .describe(
          "The number of scroll wheel ticks. Optional for `scroll`, defaults to 3."
        ),
      start_coordinate: z
        .array(z.number())
        .min(2)
        .max(2)
        .optional()
        .describe("(x, y): The starting coordinates for `left_click_drag`."),
      text: z
        .string()
        .optional()
        .describe(
          'The text to type (for `type` action) or the key(s) to press (for `key` action). For `key` action: Provide space-separated keys (e.g., "Backspace Backspace Delete"). Supports keyboard shortcuts using the platform\'s modifier key (use "cmd" on Mac, "ctrl" on Windows/Linux, e.g., "cmd+a" or "ctrl+a" for select all).'
        )
    }
  },
  {
    name: "find",
    description:
      'Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content (e.g., "organic mango product"). Returns up to 20 matching elements with references that can be used with other tools. If more than 20 matches exist, you\'ll be notified to use a more specific query. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
    paramShape: {
      query: z
        .string()
        .describe(
          'Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")'
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID to search in. Any open tab. Use tabs_context_mcp first if you don't have a valid tab ID; prefer the tab it reports as currentTab."
        )
    }
  },
  {
    name: "form_input",
    description:
      "Set values in form elements using element reference ID from the read_page tool. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      ref: z
        .string()
        .describe(
          'Element reference ID from the read_page tool (e.g., "ref_1", "ref_2")'
        ),
      value: z
        .union([z.string(), z.boolean(), z.number()])
        .describe(
          "The value to set. For checkboxes use boolean, for selects use option value or text, for other inputs use appropriate string/number"
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID to set form value in. Any open tab. Use tabs_context_mcp first if you don't have a valid tab ID; prefer the tab it reports as currentTab."
        )
    }
  },
  {
    name: "get_page_text",
    description:
      "Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      tabId: z
        .number()
        .describe(
          "Tab ID to extract text from. Any open tab. Use tabs_context_mcp first if you don't have a valid tab ID; prefer the tab it reports as currentTab."
        )
    }
  },
  {
    name: "gif_creator",
    description:
      "Manage GIF recording and export for browser automation sessions. Control when to start/stop recording browser actions (clicks, scrolls, navigation), then export as an animated GIF with visual overlays (click indicators, action labels, progress bar, watermark). All operations are scoped to the tab's group. When starting recording, take a screenshot immediately after to capture the initial state as the first frame. When stopping recording, take a screenshot immediately before to capture the final state as the last frame. For export, either provide 'coordinate' to drag/drop upload to a page element, or set 'download: true' to download the GIF.",
    paramShape: {
      action: z
        .enum(["start_recording", "stop_recording", "export", "clear"])
        .describe(
          "Action to perform: 'start_recording' (begin capturing), 'stop_recording' (stop capturing but keep frames), 'export' (generate and export GIF), 'clear' (discard frames)"
        ),
      tabId: z
        .number()
        .describe("Tab ID to identify which tab group this operation applies to"),
      download: z
        .boolean()
        .optional()
        .describe(
          "Always set this to true for the 'export' action only. This causes the gif to be downloaded in the browser."
        ),
      filename: z
        .string()
        .optional()
        .describe(
          "Optional filename for exported GIF (default: 'recording-[timestamp].gif'). For 'export' action only."
        ),
      options: z
        .object({
          showClickIndicators: z
            .boolean()
            .optional()
            .describe("Show orange circles at click locations (default: true)"),
          showDragPaths: z
            .boolean()
            .optional()
            .describe("Show red arrows for drag actions (default: true)"),
          showActionLabels: z
            .boolean()
            .optional()
            .describe("Show black labels describing actions (default: true)"),
          showProgressBar: z
            .boolean()
            .optional()
            .describe("Show orange progress bar at bottom (default: true)"),
          showWatermark: z
            .boolean()
            .optional()
            .describe("Show Claude logo watermark (default: true)"),
          quality: z
            .number()
            .optional()
            .describe(
              "GIF compression quality, 1-30 (lower = better quality, slower encoding). Default: 10"
            )
        })
        .optional()
        .describe(
          "Optional GIF enhancement options for 'export' action. Properties: showClickIndicators (bool), showDragPaths (bool), showActionLabels (bool), showProgressBar (bool), showWatermark (bool), quality (number 1-30). All default to true except quality (default: 10)."
        )
    }
  },
  {
    name: "javascript_tool",
    description:
      "Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      action: z
        .literal("javascript_exec")
        .describe("Must be set to 'javascript_exec'"),
      text: z
        .string()
        .describe(
          "The JavaScript code to execute. The code will be evaluated in the page context. The result of the last expression will be returned automatically. Do NOT use 'return' statements - just write the expression you want to evaluate (e.g., 'window.myData.value' not 'return window.myData.value'). You can access and modify the DOM, call page functions, and interact with page variables."
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID to execute the code in. Any open tab. Use tabs_context_mcp first if you don't have a valid tab ID; prefer the tab it reports as currentTab."
        )
    }
  },
  {
    name: "read_console_messages",
    description:
      "Read browser console messages (console.log, console.error, console.warn, etc.) from a specific tab. Useful for debugging JavaScript errors, viewing application logs, or understanding what's happening in the browser console. Returns console messages from the current domain only. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs. IMPORTANT: Always provide a pattern to filter messages - without a pattern, you may get too many irrelevant messages.",
    paramShape: {
      tabId: z
        .number()
        .describe(
          "Tab ID to read console messages from. Any open tab. Use tabs_context_mcp first if you don't have a valid tab ID; prefer the tab it reports as currentTab."
        ),
      pattern: z
        .string()
        .optional()
        .describe(
          "Regex pattern to filter console messages. Only messages matching this pattern will be returned (e.g., 'error|warning' to find errors and warnings, 'MyApp' to filter app-specific logs). You should always provide a pattern to avoid getting too many irrelevant messages."
        ),
      limit: z
        .number()
        .optional()
        .describe(
          "Maximum number of messages to return. Defaults to 100. Increase only if you need more results."
        ),
      onlyErrors: z
        .boolean()
        .optional()
        .describe(
          "If true, only return error and exception messages. Default is false (return all message types)."
        ),
      clear: z
        .boolean()
        .optional()
        .describe(
          "If true, clear the console messages after reading to avoid duplicates on subsequent calls. Default is false."
        )
    }
  },
  {
    name: "read_network_requests",
    description:
      "Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. Useful for debugging API calls, monitoring network activity, or understanding what requests a page is making. Returns all network requests made by the current page, including cross-origin requests. Requests are automatically cleared when the page navigates to a different domain. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      tabId: z
        .number()
        .describe(
          "Tab ID to read network requests from. Any open tab. Use tabs_context_mcp first if you don't have a valid tab ID; prefer the tab it reports as currentTab."
        ),
      urlPattern: z
        .string()
        .optional()
        .describe(
          "Optional URL pattern to filter requests. Only requests whose URL contains this string will be returned (e.g., '/api/' to filter API calls, 'example.com' to filter by domain)."
        ),
      limit: z
        .number()
        .optional()
        .describe(
          "Maximum number of requests to return. Defaults to 100. Increase only if you need more results."
        ),
      clear: z
        .boolean()
        .optional()
        .describe(
          "If true, clear the network requests after reading to avoid duplicates on subsequent calls. Default is false."
        )
    }
  },
  {
    name: "read_page",
    description:
      "Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones. Output is limited to 50000 characters by default. If the output exceeds this limit, you will receive an error asking you to specify a smaller depth or focus on a specific element using ref_id. Optionally filter for only interactive elements. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      tabId: z
        .number()
        .describe(
          "Tab ID to read from. Any open tab. Use tabs_context_mcp first if you don't have a valid tab ID; prefer the tab it reports as currentTab."
        ),
      filter: z
        .enum(["interactive", "all"])
        .optional()
        .describe(
          'Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements including non-visible ones (default: all elements)'
        ),
      depth: z
        .number()
        .optional()
        .describe(
          "Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large."
        ),
      ref_id: z
        .string()
        .optional()
        .describe(
          "Reference ID of a parent element to read. Will return the specified element and all its children. Use this to focus on a specific part of the page when output is too large."
        ),
      max_chars: z
        .number()
        .optional()
        .describe(
          "Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs."
        )
    }
  },
  {
    name: "resize_window",
    description:
      "Resize the current browser window to specified dimensions. Useful for testing responsive designs or setting up specific screen sizes. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      width: z.number().describe("Target window width in pixels"),
      height: z.number().describe("Target window height in pixels"),
      tabId: z
        .number()
        .describe(
          "Tab ID to get the window for. Any open tab. Use tabs_context_mcp first if you don't have a valid tab ID; prefer the tab it reports as currentTab."
        )
    }
  },
  {
    name: "shortcuts_list",
    description:
      "List all available shortcuts and workflows (shortcuts and workflows are interchangeable). Returns shortcuts with their commands, descriptions, and whether they are workflows. Use shortcuts_execute to run a shortcut or workflow.",
    paramShape: {
      tabId: z
        .number()
        .describe(
          "Tab ID to list shortcuts from. Any open tab. Use tabs_context_mcp first if you don't have a valid tab ID; prefer the tab it reports as currentTab."
        )
    }
  },
  {
    name: "shortcuts_execute",
    description:
      "Execute a shortcut or workflow by running it in a new sidepanel window using the current tab (shortcuts and workflows are interchangeable). Use shortcuts_list first to see available shortcuts. This starts the execution and returns immediately - it does not wait for completion.",
    paramShape: {
      tabId: z
        .number()
        .describe(
          "Tab ID to execute the shortcut on. Any open tab. Use tabs_context_mcp first if you don't have a valid tab ID; prefer the tab it reports as currentTab."
        ),
      shortcutId: z
        .string()
        .optional()
        .describe("The ID of the shortcut to execute"),
      command: z
        .string()
        .optional()
        .describe(
          "The command name of the shortcut to execute (e.g., 'debug', 'summarize'). Do not include the leading slash."
        )
    }
  },
  {
    name: "switch_browser",
    description:
      "Hand off browser automation to a different Chromium browser (Chrome, Brave, Edge). One browser drives at a time. Calling this releases the current browser's hold on the shared runtime for ~15s so a target browser with this extension enabled can take over automatically (no restart). Tell the user to enable the extension in the target browser first. After calling, wait a few seconds and use tabs_context_mcp to confirm which browser is now active.",
    paramShape: {}
  },
  {
    name: "update_plan",
    description:
      "Present a plan to the user for approval before taking actions. The user will see the domains you intend to visit and your approach. Once approved, you can proceed with actions on the approved domains without additional permission prompts.",
    paramShape: {
      domains: z
        .array(z.string())
        .describe(
          "List of domains you will visit (e.g., ['github.com', 'stackoverflow.com']). These domains will be approved for the session when the user accepts the plan."
        ),
      approach: z
        .array(z.string())
        .describe(
          "High-level description of what you will do. Focus on outcomes and key actions, not implementation details. Be concise - aim for 3-7 items."
        )
    }
  },
  {
    name: "upload_image",
    description:
      "Upload a previously captured screenshot or user-uploaded image to a file input or drag & drop target. Supports two approaches: (1) ref - for targeting specific elements, especially hidden file inputs, (2) coordinate - for drag & drop to visible locations like Google Docs. Provide either ref or coordinate, not both.",
    paramShape: {
      imageId: z
        .string()
        .describe(
          "ID of a previously captured screenshot (from the computer tool's screenshot action) or a user-uploaded image"
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID where the target element is located. This is where the image will be uploaded to."
        ),
      ref: z
        .string()
        .optional()
        .describe(
          'Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Use this for file inputs (especially hidden ones) or specific elements. Provide either ref or coordinate, not both.'
        ),
      coordinate: z
        .array(z.number())
        .optional()
        .describe(
          "Viewport coordinates [x, y] for drag & drop to a visible location. Use this for drag & drop targets like Google Docs. Provide either ref or coordinate, not both."
        ),
      filename: z
        .string()
        .optional()
        .describe(
          'Optional filename for the uploaded file (default: "image.png")'
        )
    }
  },

  // --- Browser UI, outside the page ---
  // These read and drive the browser itself rather than web content. Browser
  // chrome cannot be screenshotted or scripted by any extension, so the way to
  // inspect the bookmarks bar or the installed extensions is to read them as
  // data — which is what these do. Destructive actions refuse without
  // force: true, matching tabs_close_mcp.
  {
    name: "browser_chrome_mcp",
    description:
      "Read the state of the browser itself, outside any page: every window with its state (normal/minimized/maximized/fullscreen) and bounds, what is on the bookmarks bar, the most-visited sites, recently closed tabs and windows, and the reading list. Call this to answer questions about the user's browser rather than about a page — it is the browser-level counterpart to tabs_context_mcp, and it mutates nothing. Note that browser chrome cannot be screenshotted: read it here instead of trying to photograph the toolbar.",
    paramShape: {}
  },
  {
    name: "bookmarks_mcp",
    description:
      "Read and manage bookmarks, including everything on the bookmarks bar. action 'list' returns one folder's children (folderId defaults to the root; the bookmarks bar is folderId \"1\"), 'search' matches titles and URLs, 'create' adds a bookmark or folder (defaults onto the bookmarks bar), 'move' reparents one, 'remove' deletes one. Deleting is not undoable from here and is refused without force: true.",
    paramShape: {
      action: z
        .enum(["list", "search", "create", "move", "remove"])
        .optional()
        .describe("Defaults to 'list'."),
      folderId: z
        .string()
        .optional()
        .describe(
          'Folder to list into, create into, or move into. "1" is the bookmarks bar, "2" is Other Bookmarks. Defaults to the root for list and to the bookmarks bar for create.'
        ),
      id: z.string().optional().describe("Bookmark or folder id, for move and remove."),
      query: z.string().optional().describe("Search text, for action 'search'."),
      title: z.string().optional().describe("Title, for action 'create'."),
      url: z
        .string()
        .optional()
        .describe("URL, for action 'create'. Omit it to create a folder instead of a bookmark."),
      index: z.number().optional().describe("Optional position within the target folder, for action 'move'."),
      limit: z.number().optional().describe("Maximum results for action 'search' (default 50)."),
      force: z
        .boolean()
        .optional()
        .describe(
          "Defaults to false. Required to actually remove a bookmark, and only after the user has asked for that bookmark to be deleted. Never set this to get past a refusal on your own initiative."
        )
    }
  },
  {
    name: "history_mcp",
    description:
      "Search the user's browsing history, or erase one URL from it. action 'search' is read-only and is the right way to answer \"what was that page I looked at\". action 'delete' erases a URL's history and is refused without force: true.",
    paramShape: {
      action: z.enum(["search", "delete"]).optional().describe("Defaults to 'search'."),
      query: z.string().optional().describe("Text to match; omit to list everything in the window."),
      days: z.number().optional().describe("How far back to look, in days (default 7)."),
      limit: z.number().optional().describe("Maximum results (default 50)."),
      url: z.string().optional().describe("Exact URL to erase, for action 'delete'."),
      force: z
        .boolean()
        .optional()
        .describe(
          "Defaults to false. Required to erase history, and only after the user has explicitly asked for it."
        )
    }
  },
  {
    name: "downloads_mcp",
    description:
      "Inspect and control downloads — the download shelf's contents as data. action 'list' reports recent downloads with their progress and state, 'pause'/'resume' control one, 'show' reveals the file in the OS file manager, 'cancel' aborts one and loses the partial file (refused without force: true). This never opens or executes a downloaded file.",
    paramShape: {
      action: z
        .enum(["list", "pause", "resume", "show", "cancel"])
        .optional()
        .describe("Defaults to 'list'."),
      id: z.number().optional().describe("Download id from action 'list'; required by every action except 'list'."),
      query: z.string().optional().describe("Filter text for action 'list'."),
      limit: z.number().optional().describe("Maximum results for action 'list' (default 25)."),
      force: z
        .boolean()
        .optional()
        .describe("Defaults to false. Required to cancel a download, and only after the user has asked.")
    }
  },
  {
    name: "extensions_mcp",
    description:
      "Read and manage the browser's installed extensions — what chrome://extensions shows, which no extension can script or screenshot. action 'list' is read-only and reports each extension's id, version, enabled state and permissions. 'enable' turns one on. 'disable' and 'uninstall' are refused without force: true, and are refused outright for this extension itself, since that would sever the connection you are working over.",
    paramShape: {
      action: z
        .enum(["list", "enable", "disable", "uninstall"])
        .optional()
        .describe("Defaults to 'list'."),
      id: z.string().optional().describe("Extension id from action 'list'; required by every action except 'list'."),
      force: z
        .boolean()
        .optional()
        .describe(
          "Defaults to false. Required to disable or uninstall an extension, and only after the user has explicitly asked for that extension."
        )
    }
  },
  {
    name: "window_control_mcp",
    description:
      "Change a browser window's frame: minimize, maximize, restore, go fullscreen, focus it, or move and resize it. Defaults to the focused window. Use this for the window itself; use resize_window when what you actually need is to change a page's rendered viewport for a screenshot, since that also repoints the CDP metrics override.",
    paramShape: {
      windowId: z
        .number()
        .optional()
        .describe("Window to act on, from browser_chrome_mcp. Defaults to the focused window."),
      state: z
        .enum(["normal", "minimized", "maximized", "fullscreen"])
        .optional()
        .describe("New window state."),
      focused: z.boolean().optional().describe("Set true to bring the window to the front."),
      left: z.number().optional().describe("New x position, in screen pixels."),
      top: z.number().optional().describe("New y position, in screen pixels."),
      width: z.number().optional().describe("New window width, in screen pixels."),
      height: z.number().optional().describe("New window height, in screen pixels.")
    }
  },

  // --- API discovery and reverse engineering ---
  // These turn a web app into a documented API. read_network_requests tells you
  // that a call happened; these capture enough to reproduce it — real headers,
  // request and response bodies, and the auth material — mine the app's own
  // JavaScript for endpoints the traffic never exercised, and write the whole
  // bundle to disk under custom_apis/<slug>/ so a client can be written against
  // it. The intended order is: api_capture start -> drive the app or api_crawl
  // -> api_capture auth -> api_fetch_source -> api_scan_source -> api_spec ->
  // api_probe to confirm anything doubtful.
  {
    name: "api_capture",
    description:
      "Record a web app's API traffic in full, so its calls can be reproduced outside the browser. Unlike read_network_requests, this correlates each request by id and keeps the real request headers the browser sent (Cookie and Authorization included), the request body, the response body and the timing, writing every request to its own file under custom_apis/<slug>/requests/ as it completes. action 'start' begins recording on a tab and disables that tab's response cache so bodies are always available; then drive the app yourself or call api_crawl. 'read' lists what has been captured so far, 'status' reports session state and crawl progress, 'stop' ends the recording. action 'auth' snapshots the live credentials — cookies scoped to the origins seen, localStorage, sessionStorage, and every auth header observed in traffic — into auth.json; do that before the session expires, and be aware it writes real secrets to disk in plaintext. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      action: z
        .enum(["start", "stop", "status", "read", "auth"])
        .optional()
        .describe("Defaults to 'status'. 'start' and 'auth' need a tabId."),
      slug: z
        .string()
        .describe(
          "Short name for this site or app, used as the folder name under custom_apis/. Reuse the same slug across every api_* call for the same target — it is what ties the capture, the crawl, the fetched sources and the spec together. Keep it filesystem-safe, e.g. 'acme-admin'."
        ),
      tabId: z
        .number()
        .optional()
        .describe(
          "Tab ID to record from. Any open tab. Use tabs_context_mcp first if you don't have a valid tab ID; prefer the tab it reports as currentTab. Required for 'start' and 'auth'."
        ),
      resourceTypes: z
        .array(z.string())
        .optional()
        .describe(
          "Which CDP resource types to record. Defaults to XHR, Fetch, Document, WebSocket and EventSource — the ones that carry API traffic. Add 'Script' if you intend to run api_fetch_source, since that is how it learns which bundles to fetch. Adding 'Image'/'Font'/'Stylesheet' mostly fills the folder with noise."
        ),
      urlPattern: z
        .string()
        .optional()
        .describe(
          "Optional substring filter. Only requests whose URL contains it are recorded (e.g. '/api/'). Applied at record time, so anything excluded is never written."
        ),
      bodyLimit: z
        .number()
        .optional()
        .describe("Maximum response body bytes to keep per request (default 524288). Bodies over the limit are truncated and flagged."),
      limit: z.number().optional().describe("For action 'read': maximum requests to list (default 100, most recent last)."),
      allCookies: z
        .boolean()
        .optional()
        .describe(
          "For action 'auth'. Defaults to false, which scopes the cookie dump to the origins this capture actually saw. Set true only if you specifically need every cookie in the browser — it writes the user's whole cookie jar to disk."
        )
    }
  },
  {
    name: "api_fetch_source",
    description:
      "Fetch the app's JavaScript so its endpoints can be mined statically — the half of the API surface that traffic capture cannot see, because the crawl never triggered it. Fetches from the extension rather than from the page, so it is not blocked by CORS or the page's connect-src, which is what defeats the obvious javascript_tool + fetch approach on real apps. Follows sourceMappingURL and, when the map ships sourcesContent, writes the original unminified sources too — that makes the subsequent scan both accurate and attributable instead of pointing at a column offset in a bundle. Everything lands under custom_apis/<slug>/static/. Run api_scan_source next, in the same session: this tool keeps the fetched text in memory for it, because the extension can write files but cannot read them back.",
    paramShape: {
      slug: z.string().describe("The site's slug — the same one used for api_capture."),
      tabId: z
        .number()
        .optional()
        .describe(
          "Tab ID to read the script list from when nothing has been captured yet. Use tabs_context_mcp first if you don't have a valid tab ID; prefer the tab it reports as currentTab."
        ),
      url: z.string().optional().describe("Fetch this one URL instead of every script the app loaded. Useful for an OpenAPI document a scan turned up."),
      all: z
        .boolean()
        .optional()
        .describe("Defaults to true: fetch every distinct script the capture saw, falling back to asking the page what it loaded."),
      sourcemaps: z.boolean().optional().describe("Defaults to true. Set false to skip .map files and original sources."),
      limit: z.number().optional().describe("Maximum scripts to fetch (default 40). Bundles are large; raise it deliberately."),
      includeThirdParty: z
        .boolean()
        .optional()
        .describe(
          "Defaults to false: only scripts from the app's own domain are fetched. Third-party tags are analytics and ads, and leaving them in means Google Tag Manager alone contributes hundreds of tracking endpoints that bury the app's real API. Set true if the app genuinely serves its own code from another domain and the default found nothing useful."
        )
    }
  },
  {
    name: "api_scan_source",
    description:
      "Mine the JavaScript fetched by api_fetch_source for API endpoints, and write the candidates to custom_apis/<slug>/static/findings.json. Finds quoted paths and URLs, template literals with their interpolations normalized to {param}, fetch/axios/jQuery/XMLHttpRequest call sites together with their HTTP method, GraphQL operations, and references to a swagger/openapi document — which, if one turns up, is worth more than everything else this tool reports and should be fetched directly. Results are ranked, since a bundle contains thousands of strings with a slash in them. Treat these as leads to confirm with api_probe, not as facts: this is regex over minified code, tuned for recall.",
    paramShape: {
      slug: z.string().describe("The site's slug — the same one used for api_capture and api_fetch_source.")
    }
  },
  {
    name: "api_crawl",
    description:
      "Walk a web app to discover its routes and, more importantly, which API calls each route fires. Seeds from the tab's current page, then follows same-origin links and whatever the framework will admit about its own route table (Next.js, Remix, Nuxt, Vue Router) — that route table matters, because on many SPAs most of the app is not reachable from the links on the current page. Requires a capture, and starts one automatically if none is running. Writes routes.json and a screenshot per page as it goes. This returns immediately and keeps working in the background, because a crawl outlasts a single tool call: poll api_capture action:'status' for progress and api_capture action:'read' for what it found. By default it only navigates. URLs and controls whose text suggests they change state (logout, delete, pay, submit…) are always skipped, force or not. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      slug: z.string().describe("The site's slug — the folder under custom_apis/ this crawl writes into."),
      tabId: z
        .number()
        .describe(
          "Tab ID to crawl in. This tab will be navigated repeatedly, so use a tab the user is not working in. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
      action: z.enum(["start", "stop"]).optional().describe("Defaults to 'start'. 'stop' halts a running crawl after the page in flight."),
      url: z.string().optional().describe("Seed URL. Defaults to whatever the tab is currently on."),
      maxPages: z.number().optional().describe("Maximum pages to visit (default 25)."),
      maxDepth: z.number().optional().describe("Maximum link depth from the seed (default 3)."),
      sameOriginOnly: z.boolean().optional().describe("Defaults to true. Leave it true unless the app genuinely spans origins."),
      budgetSeconds: z.number().optional().describe("Wall-clock ceiling for the whole crawl (default 120). It stops cleanly when the budget runs out."),
      screenshot: z.boolean().optional().describe("Defaults to true: one PNG per page into screenshots/."),
      interact: z
        .boolean()
        .optional()
        .describe(
          "Defaults to false. When true, also clicks ordinary controls (buttons, tabs, menu items) on each page to trigger API calls that plain navigation never fires. This acts on the user's real logged-in session and can change data, so it is refused without force: true."
        ),
      maxClicks: z.number().optional().describe("Maximum controls to click per page when interact is on (default 8)."),
      denyPattern: z
        .string()
        .optional()
        .describe("Extra case-insensitive regex of URLs to skip, on top of the built-in state-changing deny list."),
      force: z
        .boolean()
        .optional()
        .describe(
          "Defaults to false. Required only to enable interact: true, and only after the user has agreed to the crawler clicking things in their live session. Never set this on your own initiative to get past the refusal."
        ),
      resourceTypes: z.array(z.string()).optional().describe("Passed through to the capture if this crawl has to start one."),
      urlPattern: z.string().optional().describe("Passed through to the capture if this crawl has to start one."),
      bodyLimit: z.number().optional().describe("Passed through to the capture if this crawl has to start one.")
    }
  },
  {
    name: "api_spec",
    description:
      "Turn everything gathered for a slug into an endpoint catalog and an OpenAPI 3 document, written to custom_apis/<slug>/endpoints.json and openapi.json. Groups the captured traffic by method and templated path (/users/42 becomes /users/{userId}), infers JSON Schemas for request and response bodies from the observed payloads — a field missing from one sample is what makes it optional — collects query parameters with examples, and records which auth headers each endpoint was called with. Endpoints that only static analysis found are included and marked x-observed: false, because an endpoint mined from a bundle is a lead rather than a fact. This is the input for writing the client: read openapi.json for the contract and auth.json for the credentials.",
    paramShape: {
      slug: z.string().describe("The site's slug."),
      includeStatic: z
        .boolean()
        .optional()
        .describe("Defaults to true: fold in api_scan_source's findings as unobserved endpoints. Set false for a traffic-only spec."),
      scoreFloor: z
        .number()
        .optional()
        .describe(
          "Minimum confidence score a source-only finding needs to appear in the spec (default 3). Lower-scoring candidates stay in static/findings.json, and the tool tells you how many it held back — a spec listing every string in a bundle is worse than one listing none, because it buries the endpoints that are real. Set 0 to include everything."
        )
    }
  },
  {
    name: "api_probe",
    description:
      "Replay a captured call to confirm what it actually requires, which is how a guess becomes a documented endpoint. Runs from the page context by default, so the request inherits the app's origin, cookies and CSP — a call that only works from elsewhere has proved nothing. For safe methods it also repeats the call with credentials omitted and reports whether authentication is genuinely required, which is usually the thing you most need to know. Each probe is saved under custom_apis/<slug>/probes/. Only GET, HEAD and OPTIONS are allowed; anything that can change data is refused without force: true.",
    paramShape: {
      slug: z.string().describe("The site's slug."),
      endpoint: z
        .string()
        .describe(
          "What to call: a full URL, a path relative to the captured origin, or '#12' to replay captured request 12 exactly as api_capture action:'read' numbered it (which also reuses its auth headers)."
        ),
      method: z.string().optional().describe("HTTP method (default GET). Anything other than GET/HEAD/OPTIONS is refused without force: true."),
      headers: z.record(z.string()).optional().describe("Extra request headers, merged over the ones the captured request used. Cookie is ignored — the browser attaches it."),
      body: z.string().optional().describe("Request body, for methods that take one."),
      fromPage: z
        .boolean()
        .optional()
        .describe("Defaults to true: run in the page's context. Set false to call from the extension instead, which bypasses CORS and the page CSP but does not prove the app's own client could make the call."),
      tabId: z.number().optional().describe("Tab to run the probe in. Defaults to the tab the capture is attached to."),
      force: z
        .boolean()
        .optional()
        .describe(
          "Defaults to false. Required for any method that is not GET, HEAD or OPTIONS, and only after the user has agreed to a request that may change real data."
        )
    }
  },
  {
    name: "api_hosts",
    description:
      "Inventory the hosts and subdomains that make up a site, which is the part of a map you cannot get by clicking. Merges six sources: hosts the capture actually talked to, every host named in the app's Content-Security-Policy (a site's own written list of the backends its code may contact — usually the richest source by far), absolute URLs left in the JS bundles api_fetch_source pulled down, the page's dns-prefetch/preconnect hints, robots.txt and sitemap.xml, and optionally certificate transparency logs. Each host is reported with which sources named it and whether it is inside the target domain. Run api_capture and api_fetch_source first: with no traffic and no bundles, only the public files are available and the result is thin. Writes custom_apis/<slug>/hosts.json.",
    paramShape: {
      slug: z.string().describe("The site's slug."),
      domain: z
        .string()
        .optional()
        .describe(
          "Registrable domain that defines what counts as this site's own host, e.g. 'example.com'. Defaults to the base domain of the captured origin, or of the tab's current page."
        ),
      tabId: z
        .number()
        .optional()
        .describe(
          "Tab to read page hints from. Get tab ids from tabs_context_mcp. Defaults to the tab the capture is attached to; without one, page hints are skipped."
        ),
      ct: z
        .boolean()
        .optional()
        .describe(
          "Defaults to false. Query crt.sh certificate transparency logs, which is the only source here that finds hosts the app never mentions anywhere. It sends the target domain to a third party, so it is opt-in rather than a surprise."
        ),
      probe: z
        .boolean()
        .optional()
        .describe(
          "Defaults to false. GET the root of each in-scope host and report status, server and whether it looks like an API host. Only touches hosts inside the target domain."
        ),
      limit: z.number().optional().describe("Maximum in-scope hosts to probe (default 60).")
    }
  },
  {
    name: "api_wellknown",
    description:
      "Ask a site whether it publishes a machine-readable description of its own API, and merge it in if it does. Tries the well-known OpenAPI and Swagger locations (/openapi.json, /swagger.json, /v3/api-docs, /api/schema/ and a dozen more) and, on request, a GraphQL introspection query. When one of these answers you get the complete API surface in a single call, including every endpoint the UI has no button for — which is exactly the surface a crawl cannot reach. Anything found is added to the session's findings at high confidence, so a following api_spec merges it with the observed traffic. Status alone is not treated as a hit: a single-page app answers 200 with its index.html for any unknown path, so the document has to actually parse and declare paths.",
    paramShape: {
      slug: z.string().describe("The site's slug."),
      origin: z
        .string()
        .optional()
        .describe("A single origin to ask, e.g. 'https://api.example.com'. Defaults to the origins the capture observed."),
      useHosts: z
        .boolean()
        .optional()
        .describe(
          "Defaults to false. Ask every in-scope host that api_hosts found instead of just the captured origins — the usual way to find a spec published by an API subdomain the UI never calls."
        ),
      graphql: z
        .boolean()
        .optional()
        .describe(
          "Defaults to false. Also try a GraphQL introspection query at the usual paths. Introspection only reads the schema, but it is a POST, so it additionally needs force: true."
        ),
      tabId: z.number().optional().describe("Tab to associate with the session. Defaults to the tab the capture is attached to."),
      limit: z.number().optional().describe("Maximum hosts to ask when useHosts is set (default 25)."),
      force: z.boolean().optional().describe("Defaults to false. Required alongside graphql: true, because introspection is sent as a POST.")
    }
  }
];

/**
 * Convert a tool's paramShape to a JSON Schema object suitable for
 * MCP tools/list, codemode TS-API generation, etc.
 */
export function toolInputJsonSchema(tool) {
  const schema = zodToJsonSchema(z.object(tool.paramShape), {
    target: "openApi3",
    $refStrategy: "none"
  });
  // zodToJsonSchema wraps with $schema by default; strip it for cleanliness
  if (schema && typeof schema === "object") {
    delete schema.$schema;
  }
  return schema;
}

export function toolsAsJsonSchemaList() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toolInputJsonSchema(t)
  }));
}

// --- In-process TS-API generator (no workerd needed) -------------------------
//
// Used by the codemode + hybrid MCP servers to build execute_code's
// description synchronously at startup, so server.connect(stdio) can happen
// before wrangler is ready. Mirrors the output shape of
// @cloudflare/codemode's generateTypesFromJsonSchema closely enough for the
// model: namespaced declare const + per-tool JSDoc + per-param descriptions.

function pascal(name) {
  return name
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .split("_")
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join("");
}

function escapeJsdoc(s) {
  return String(s).replace(/\*\//g, "*\\/");
}

function tsType(schema) {
  if (!schema || typeof schema !== "object") return "unknown";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.anyOf || schema.oneOf) {
    const variants = (schema.anyOf || schema.oneOf).map(tsType);
    return variants.join(" | ");
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `(${tsType(schema.items || {})})[]`;
    case "object": {
      const required = new Set(schema.required || []);
      const props = schema.properties || {};
      const fields = Object.entries(props).map(([k, v]) => {
        const opt = required.has(k) ? "" : "?";
        const doc = v && v.description ? `    /** ${escapeJsdoc(String(v.description).replace(/\s+/g, " "))} */\n    ` : "    ";
        return `${doc}${k}${opt}: ${tsType(v)};`;
      });
      return `{\n${fields.join("\n")}\n}`;
    }
    default:
      return "unknown";
  }
}

/**
 * Build the TypeScript API block exposed to the model inside execute_code.
 * `tools` is a list of { name, description, inputSchema } records (the same
 * shape toolsAsJsonSchemaList() returns); `namespace` controls the binding
 * name (e.g. "chrome" → `declare const chrome: {...}`).
 */
export function generateTsApi(tools, namespace = "codemode") {
  let types = "";
  let api = "";
  for (const t of tools) {
    const typeName = pascal(t.name);
    const inputBody = tsType(t.inputSchema || { type: "object" });
    types += `\ntype ${typeName}Input = ${inputBody}`;
    types += `\ntype ${typeName}Output = unknown`;

    const descLine = t.description
      ? escapeJsdoc(String(t.description).replace(/\s+/g, " "))
      : t.name;
    api += `\n\t/**\n\t * ${descLine}\n\t */`;
    api += `\n\t${t.name}: (input: ${typeName}Input) => Promise<${typeName}Output>;`;
    api += "\n";
  }
  return `${types}\n\ndeclare const ${namespace}: {${api}}`.trim();
}
