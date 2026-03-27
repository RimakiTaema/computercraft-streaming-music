local api_base_url = "SetMe"
-- Versioning:
-- X.X.1 => Minor change (usually no forced client update unless bugfix needed)
-- X.1.X => Medium change (client update recommended if behavior changes)
-- 1.X.X => Major change (client update required)
local version = "3.0.0_vibe"

local width, height = term.getSize()
local tab = 1

-- UI state
local waiting_for_input = false
local last_search = nil
local last_search_url = nil
local search_results = nil
local search_error = false
local in_search_result = false
local clicked_result = nil
local changelog_results = nil
local changelog_error = false
local last_changelog_url = nil
local in_changelog_item = false
local clicked_changelog = nil

-- Scroll state
local search_scroll = 0
local queue_scroll = 0
local changelog_scroll = 0

-- Playback state
local playing = false
local queue = {}
local now_playing = nil
local looping = 0
local volume = 1.5
local shuffled = false

local playing_id = nil
local last_download_url = nil
local playing_status = 0
local is_loading = false
local is_error = false

local player_handle = nil
local start = nil
local pcm = nil
local size = nil
local decoder = require "cc.audio.dfpwm".make_decoder()
local needs_next_chunk = 0
local buffer

-- Visualizer state
local viz_bars = {}
local viz_bar_count = 0
local VIZ_DECAY = 0.7
local VIZ_CHARS = {" ", "\x83", "\x8f", "\x8f"} -- subpixel block chars

-- Animation state
local anim_frame = 0
local anim_timer = nil

-- Theme colors
local C_BG        = colors.black
local C_TAB_BG    = colors.gray
local C_TAB_FG    = colors.lightGray
local C_TAB_SEL   = colors.cyan
local C_TAB_SEL_FG= colors.white
local C_ACCENT    = colors.cyan
local C_TITLE     = colors.white
local C_ARTIST    = colors.lightGray
local C_BTN_BG    = colors.gray
local C_BTN_FG    = colors.white
local C_BTN_ACT   = colors.cyan
local C_BTN_DIS   = colors.lightGray
local C_SLIDER_BG = colors.gray
local C_SLIDER_FG = colors.cyan
local C_VIZ       = colors.cyan
local C_VIZ2      = colors.purple
local C_QUEUE_NUM = colors.cyan
local C_ERROR     = colors.red
local C_LOADING   = colors.yellow
local C_HINT      = colors.gray
local C_SEARCH_BG = colors.gray
local C_SEARCH_FG = colors.white
local C_SEARCH_PH = colors.lightGray

local speakers = { peripheral.find("speaker") }
if #speakers == 0 then
	error("No speakers attached. Connect a speaker to this computer.", 0)
end

if api_base_url == "SetMe" then
	error("Set api_base_url before using. Edit with: edit music", 0)
end

if string.sub(api_base_url, -1) ~= "/" then
	api_base_url = api_base_url .. "/"
end

-- Helpers

local function ellipsize(text, max_len)
	local value = tostring(text or "")
	if max_len <= 0 then return "" end
	if #value <= max_len then return value end
	if max_len <= 3 then return string.sub(value, 1, max_len) end
	return string.sub(value, 1, max_len - 3) .. "..."
end

local function centerText(text, y, fg, bg)
	term.setBackgroundColor(bg or C_BG)
	term.setTextColor(fg or C_TITLE)
	term.setCursorPos(math.floor((width - #text) / 2) + 1, y)
	term.write(text)
end

local function drawButton(x, y, label, active, disabled)
	if active then
		term.setBackgroundColor(C_BTN_ACT)
		term.setTextColor(colors.black)
	elseif disabled then
		term.setBackgroundColor(C_BTN_BG)
		term.setTextColor(C_BTN_DIS)
	else
		term.setBackgroundColor(C_BTN_BG)
		term.setTextColor(C_BTN_FG)
	end
	term.setCursorPos(x, y)
	term.write(" " .. label .. " ")
	return #label + 2
end

local function flashButton(x, y, label)
	term.setBackgroundColor(colors.white)
	term.setTextColor(colors.black)
	term.setCursorPos(x, y)
	term.write(" " .. label .. " ")
	sleep(0.15)
end

local function drawHintBar(text)
	term.setBackgroundColor(C_TAB_BG)
	term.setTextColor(C_HINT)
	term.setCursorPos(1, height)
	term.clearLine()
	term.setCursorPos(2, height)
	term.write(ellipsize(text, width - 2))
end

local function loadingText()
	local dots = string.rep(".", (anim_frame % 3) + 1)
	return "Loading" .. dots .. string.rep(" ", 3 - #dots)
end

local function shuffleQueue()
	for i = #queue, 2, -1 do
		local j = math.random(1, i)
		queue[i], queue[j] = queue[j], queue[i]
	end
end

local function initVisualizer()
	viz_bar_count = width - 4
	viz_bars = {}
	for i = 1, viz_bar_count do
		viz_bars[i] = 0
	end
end

local function updateVisualizer(audio_buffer)
	if not audio_buffer or #audio_buffer == 0 then return end
	local bars = viz_bar_count
	if bars <= 0 then return end
	local samples_per_bar = math.max(1, math.floor(#audio_buffer / bars))
	for i = 1, bars do
		local sum = 0
		local base = (i - 1) * samples_per_bar
		for j = 1, samples_per_bar do
			local idx = base + j
			if idx <= #audio_buffer then
				local sample = audio_buffer[idx]
				if sample then
					sum = sum + math.abs(sample)
				end
			end
		end
		local avg = sum / samples_per_bar
		local normalized = math.min(1, avg / 80)
		local target = normalized * 8
		-- Smooth: rise fast, decay slow
		if target > viz_bars[i] then
			viz_bars[i] = target
		else
			viz_bars[i] = viz_bars[i] * VIZ_DECAY
		end
	end
end

local function clearVisualizer()
	for i = 1, viz_bar_count do
		viz_bars[i] = 0
	end
end

local function drawVisualizer(y_start, bar_height)
	if viz_bar_count <= 0 then return end
	term.setBackgroundColor(C_BG)
	for row = 0, bar_height - 1 do
		local y = y_start + row
		local threshold = (bar_height - row) * (8 / bar_height)
		term.setCursorPos(3, y)
		for i = 1, viz_bar_count do
			local val = viz_bars[i] or 0
			if val >= threshold then
				if row < bar_height / 3 then
					term.setTextColor(C_VIZ2)
				else
					term.setTextColor(C_VIZ)
				end
				term.write("\x7f")
			elseif val >= threshold - (8 / bar_height) * 0.5 then
				term.setTextColor(C_VIZ)
				term.write("\x8f")
			else
				term.setTextColor(C_BG)
				term.write(" ")
			end
		end
	end
end

-- Draw functions

function redrawScreen()
	if waiting_for_input then return end
	term.setCursorBlink(false)
	term.setBackgroundColor(C_BG)
	term.clear()

	-- Tab bar
	term.setCursorPos(1, 1)
	term.setBackgroundColor(C_TAB_BG)
	term.clearLine()

	local tab_labels = {"\x0e Now Playing", "\x06 Search", "\x10 Updates"}
	local tab_w = math.floor(width / #tab_labels)

	for i = 1, #tab_labels do
		local label = tab_labels[i]
		local x = (i - 1) * tab_w + 1
		if tab == i then
			term.setBackgroundColor(C_TAB_SEL)
			term.setTextColor(C_TAB_SEL_FG)
		else
			term.setBackgroundColor(C_TAB_BG)
			term.setTextColor(C_TAB_FG)
		end
		term.setCursorPos(x, 1)
		local pad = tab_w - #label
		local lpad = math.floor(pad / 2)
		term.write(string.rep(" ", lpad) .. label .. string.rep(" ", pad - lpad))
	end

	-- Line under tabs
	term.setCursorPos(1, 2)
	term.setBackgroundColor(C_BG)
	for i = 1, width do
		local col_tab = math.floor((i - 1) / tab_w) + 1
		if col_tab > #tab_labels then col_tab = #tab_labels end
		if col_tab == tab then
			term.setTextColor(C_ACCENT)
			term.write("\x8c")
		else
			term.setTextColor(C_TAB_BG)
			term.write("\x8c")
		end
	end

	if tab == 1 then
		drawNowPlaying()
	elseif tab == 2 then
		drawSearch()
	elseif tab == 3 then
		drawChangelogs()
	end
end

function drawNowPlaying()
	local has_content = now_playing ~= nil or #queue > 0

	if now_playing ~= nil then
		-- Song title
		term.setBackgroundColor(C_BG)
		term.setTextColor(C_ACCENT)
		term.setCursorPos(2, 3)
		term.write("\x0e ")
		term.setTextColor(C_TITLE)
		term.write(ellipsize(now_playing.name, width - 4))
		-- Artist
		term.setTextColor(C_ARTIST)
		term.setCursorPos(4, 4)
		term.write(ellipsize(now_playing.artist, width - 4))
	else
		term.setBackgroundColor(C_BG)
		term.setTextColor(C_HINT)
		centerText("No song playing", 3)
		term.setTextColor(C_HINT)
		centerText("Search for music to get started", 5)
	end

	-- Status line
	if is_loading then
		term.setTextColor(C_LOADING)
		term.setBackgroundColor(C_BG)
		term.setCursorPos(2, 5)
		term.write(loadingText())
	elseif is_error then
		term.setTextColor(C_ERROR)
		term.setBackgroundColor(C_BG)
		term.setCursorPos(2, 5)
		term.write("! Network error")
	end

	-- Visualizer (rows 6-8, 3 rows tall)
	if playing and now_playing then
		drawVisualizer(6, 3)
	end

	-- Controls on row 9
	local cx = 2
	local btn_row = 9

	if playing then
		cx = cx + drawButton(cx, btn_row, "Stop", false, false) + 1
	else
		cx = cx + drawButton(cx, btn_row, "Play", false, not has_content) + 1
	end
	cx = cx + drawButton(cx, btn_row, ">>", false, not has_content) + 1

	-- Loop button
	local loop_label = looping == 0 and "Loop" or (looping == 1 and "L.Q" or "L.1")
	cx = cx + drawButton(cx, btn_row, loop_label, looping ~= 0, false) + 1

	-- Shuffle button
	drawButton(cx, btn_row, "Shf", shuffled, false)

	-- Volume slider on row 10
	local vol_row = 10
	local slider_start = 4
	local slider_end = width - 6
	local slider_len = slider_end - slider_start

	term.setBackgroundColor(C_BG)
	term.setTextColor(C_ACCENT)
	term.setCursorPos(2, vol_row)
	term.write("\x87 ")

	-- Draw slider track
	local fill = math.floor(slider_len * (volume / 3) + 0.5)
	for i = 0, slider_len - 1 do
		term.setCursorPos(slider_start + i, vol_row)
		if i < fill then
			term.setBackgroundColor(C_SLIDER_FG)
			term.write(" ")
		else
			term.setBackgroundColor(C_SLIDER_BG)
			term.write(" ")
		end
	end

	-- Volume percentage
	term.setBackgroundColor(C_BG)
	term.setTextColor(C_TITLE)
	term.setCursorPos(slider_end + 1, vol_row)
	local pct = math.floor(100 * (volume / 3) + 0.5)
	term.write(" " .. pct .. "%")

	-- Queue section
	local q_start = 12
	local q_visible = math.max(0, math.floor((height - q_start - 1) / 2))

	if #queue > 0 then
		term.setBackgroundColor(C_BG)
		term.setTextColor(C_ACCENT)
		term.setCursorPos(2, 11)
		term.write("Queue (" .. #queue .. ")")

		-- Clear queue button
		local clr_label = "Clear"
		local clr_x = width - #clr_label - 2
		drawButton(clr_x, 11, clr_label, false, false)

		-- Scroll indicator
		if #queue > q_visible and queue_scroll > 0 then
			term.setTextColor(C_HINT)
			term.setCursorPos(width, q_start)
			term.write("\x1e") -- up arrow
		end
		if #queue > q_visible and queue_scroll + q_visible < #queue then
			term.setTextColor(C_HINT)
			term.setCursorPos(width, q_start + (q_visible - 1) * 2)
			term.write("\x1f") -- down arrow
		end

		for i = 1, q_visible do
			local idx = i + queue_scroll
			if idx > #queue then break end
			local y = q_start + (i - 1) * 2
			term.setBackgroundColor(C_BG)
			term.setTextColor(C_QUEUE_NUM)
			term.setCursorPos(2, y)
			term.write(tostring(idx) .. ".")
			term.setTextColor(C_TITLE)
			term.setCursorPos(2 + #tostring(idx) + 1, y)
			term.write(ellipsize(queue[idx].name, width - 3 - #tostring(idx)))
			term.setTextColor(C_ARTIST)
			term.setCursorPos(2 + #tostring(idx) + 1, y + 1)
			term.write(ellipsize(queue[idx].artist, width - 3 - #tostring(idx)))
		end
	end

	-- Hint bar
	if #queue > 0 then
		drawHintBar("<-/-> tabs | +/- vol | Click queue to remove")
	else
		drawHintBar("<-/-> tabs | +/- vol | Search to add music")
	end
end

function drawSearch()
	-- Search bar
	term.setBackgroundColor(C_BG)
	term.setTextColor(C_ACCENT)
	term.setCursorPos(2, 3)
	term.write("\x06 ")

	local sb_start = 4
	local sb_end = width - 1
	term.setCursorPos(sb_start, 3)
	term.setBackgroundColor(C_SEARCH_BG)
	term.write(string.rep(" ", sb_end - sb_start + 1))
	term.setCursorPos(sb_start + 1, 3)
	if last_search then
		term.setTextColor(C_SEARCH_FG)
		term.write(ellipsize(last_search, sb_end - sb_start - 1))
	else
		term.setTextColor(C_SEARCH_PH)
		term.write("Search or paste URL...")
	end

	-- Search results
	local r_start = 5
	local r_visible = math.max(0, math.floor((height - r_start - 1) / 2))

	if search_results ~= nil then
		-- Scroll indicators
		if #search_results > r_visible and search_scroll > 0 then
			term.setBackgroundColor(C_BG)
			term.setTextColor(C_HINT)
			term.setCursorPos(width, r_start)
			term.write("\x1e")
		end
		if #search_results > r_visible and search_scroll + r_visible < #search_results then
			term.setBackgroundColor(C_BG)
			term.setTextColor(C_HINT)
			term.setCursorPos(width, r_start + (r_visible - 1) * 2)
			term.write("\x1f")
		end

		term.setBackgroundColor(C_BG)
		for i = 1, r_visible do
			local idx = i + search_scroll
			if idx > #search_results then break end
			local y = r_start + (i - 1) * 2
			local is_playlist = search_results[idx].type == "playlist"

			term.setTextColor(C_ACCENT)
			term.setCursorPos(2, y)
			if is_playlist then
				term.write("\x10 ")
			else
				term.write("\x0e ")
			end
			term.setTextColor(C_TITLE)
			term.write(ellipsize(search_results[idx].name, width - 4))
			term.setTextColor(C_ARTIST)
			term.setCursorPos(4, y + 1)
			local artist_text = search_results[idx].artist or ""
			if is_playlist and search_results[idx].playlist_items then
				artist_text = artist_text .. " (" .. #search_results[idx].playlist_items .. " songs)"
			end
			term.write(ellipsize(artist_text, width - 4))
		end
	else
		term.setCursorPos(2, r_start)
		term.setBackgroundColor(C_BG)
		if search_error then
			term.setTextColor(C_ERROR)
			term.write("! Network error")
		elseif last_search_url ~= nil then
			term.setTextColor(C_LOADING)
			term.write(loadingText())
		else
			term.setTextColor(C_HINT)
			centerText("Search YouTube or paste a link", r_start)
		end
	end

	drawHintBar("Click result for options | Scroll with mouse wheel")

	-- Fullscreen song options overlay
	if in_search_result and search_results and search_results[clicked_result] then
		term.setBackgroundColor(C_BG)
		term.clear()

		local item = search_results[clicked_result]
		term.setTextColor(C_ACCENT)
		term.setCursorPos(2, 2)
		term.write("\x0e ")
		term.setTextColor(C_TITLE)
		term.write(ellipsize(item.name, width - 4))
		term.setTextColor(C_ARTIST)
		term.setCursorPos(4, 3)
		term.write(ellipsize(item.artist, width - 4))

		-- Separator
		term.setTextColor(C_TAB_BG)
		term.setCursorPos(2, 4)
		term.write(string.rep("\x8c", width - 2))

		drawButton(2, 6, "Play now", false, false)
		drawButton(2, 8, "Play next", false, false)
		drawButton(2, 10, "Add to queue", false, false)

		term.setTextColor(C_ERROR)
		term.setBackgroundColor(C_BTN_BG)
		term.setCursorPos(2, 13)
		term.write(" Cancel ")

		drawHintBar("Pick an option or press Q to cancel")
	end
end

function drawChangelogs()
	term.setBackgroundColor(C_BG)
	term.setTextColor(C_ACCENT)
	term.setCursorPos(2, 3)
	term.write("\x10 Latest Updates")

	local r_start = 5
	local r_visible = math.max(0, math.floor((height - r_start - 1) / 2))

	if changelog_results ~= nil then
		-- Scroll indicators
		if #changelog_results > r_visible and changelog_scroll > 0 then
			term.setTextColor(C_HINT)
			term.setCursorPos(width, r_start)
			term.write("\x1e")
		end
		if #changelog_results > r_visible and changelog_scroll + r_visible < #changelog_results then
			term.setTextColor(C_HINT)
			term.setCursorPos(width, r_start + (r_visible - 1) * 2)
			term.write("\x1f")
		end

		for i = 1, math.min(r_visible, #changelog_results) do
			local idx = i + changelog_scroll
			if idx > #changelog_results then break end
			local y = r_start + (i - 1) * 2
			local item = changelog_results[idx]
			term.setBackgroundColor(C_BG)
			term.setTextColor(C_ACCENT)
			term.setCursorPos(2, y)
			term.write("\x10 ")
			term.setTextColor(C_TITLE)
			local title = item.title or "Untitled"
			if item.date and item.date ~= "" then
				title = "[" .. item.date .. "] " .. title
			end
			term.write(ellipsize(title, width - 4))
			term.setTextColor(C_ARTIST)
			term.setCursorPos(4, y + 1)
			term.write("Click to read")
		end
	else
		term.setCursorPos(2, r_start)
		term.setBackgroundColor(C_BG)
		if changelog_error then
			term.setTextColor(C_ERROR)
			term.write("! Could not load changelogs")
		elseif last_changelog_url ~= nil then
			term.setTextColor(C_LOADING)
			term.write(loadingText())
		else
			term.setTextColor(C_HINT)
			centerText("Fetching changelogs...", r_start)
			-- Auto-fetch on tab open
			if last_changelog_url == nil then
				last_changelog_url = api_base_url .. "?v=" .. version .. "&changelogs=1"
				http.request(last_changelog_url)
				changelog_error = false
			end
		end
	end

	drawHintBar("<-/-> tabs | Scroll with mouse wheel")

	-- Changelog detail overlay
	if in_changelog_item and clicked_changelog and changelog_results and changelog_results[clicked_changelog] then
		local item = changelog_results[clicked_changelog]
		term.setBackgroundColor(C_BG)
		term.clear()

		term.setTextColor(C_ACCENT)
		term.setCursorPos(2, 2)
		term.write("\x10 ")
		term.setTextColor(C_TITLE)
		term.write(ellipsize(item.title, width - 4))
		term.setTextColor(C_ARTIST)
		term.setCursorPos(4, 3)
		term.write(ellipsize(item.date, width - 4))

		-- Separator
		term.setTextColor(C_TAB_BG)
		term.setCursorPos(2, 4)
		term.write(string.rep("\x8c", width - 2))

		term.setTextColor(C_TITLE)
		local lines = {}
		for line in string.gmatch(item.body or "", "[^\r\n]+") do
			table.insert(lines, line)
		end
		for i = 1, math.min(#lines, math.max(0, height - 6)) do
			term.setCursorPos(2, 4 + i)
			term.write(ellipsize(lines[i], width - 2))
		end

		drawButton(2, height - 1, "Back", false, false)
		drawHintBar("Press Q or click Back to return")
	end
end

-- Main loops

function uiLoop()
	initVisualizer()
	anim_timer = os.startTimer(0.5)
	redrawScreen()

	while true do
		if waiting_for_input then
			parallel.waitForAny(
				function()
					term.setCursorPos(5, 3)
					term.setBackgroundColor(colors.white)
					term.setTextColor(colors.black)
					local input = read()

					if string.len(input) > 0 then
						last_search = input
						search_scroll = 0
						last_search_url = api_base_url .. "?v=" .. version .. "&search=" .. textutils.urlEncode(input)
						http.request(last_search_url)
						search_results = nil
						search_error = false
					else
						last_search = nil
						last_search_url = nil
						search_results = nil
						search_error = false
					end

					waiting_for_input = false
					os.queueEvent("redraw_screen")
				end,
				function()
					while waiting_for_input do
						local event, button, x, y = os.pullEvent("mouse_click")
						if y ~= 3 or x < 4 or x > width - 1 then
							waiting_for_input = false
							os.queueEvent("redraw_screen")
							break
						end
					end
				end
			)
		else
			parallel.waitForAny(
				function()
					-- Mouse click handler
					local event, button, x, y = os.pullEvent("mouse_click")
					if button ~= 1 then return end

					-- Tab clicks (only when not in overlay)
					if y <= 2 and not in_search_result and not in_changelog_item then
						local tab_w = math.floor(width / 3)
						local new_tab = math.min(3, math.floor((x - 1) / tab_w) + 1)
						if new_tab ~= tab then
							tab = new_tab
							if tab == 3 and changelog_results == nil and last_changelog_url == nil then
								last_changelog_url = api_base_url .. "?v=" .. version .. "&changelogs=1"
								http.request(last_changelog_url)
								changelog_error = false
							end
						end
						redrawScreen()
						return
					end

					-- Tab-specific click handling
					if tab == 1 and not in_search_result then
						handleNowPlayingClick(x, y)
					elseif tab == 2 and not in_search_result then
						handleSearchClick(x, y)
					elseif tab == 2 and in_search_result then
						handleSearchResultMenuClick(x, y)
					elseif tab == 3 and not in_changelog_item then
						handleChangelogClick(x, y)
					elseif tab == 3 and in_changelog_item then
						if y == height - 1 then
							in_changelog_item = false
						end
					end
					redrawScreen()
				end,
				function()
					-- Mouse scroll handler
					local event, dir, x, y = os.pullEvent("mouse_scroll")
					if tab == 1 then
						local q_visible = math.max(0, math.floor((height - 13) / 2))
						if dir == 1 and queue_scroll + q_visible < #queue then
							queue_scroll = queue_scroll + 1
						elseif dir == -1 and queue_scroll > 0 then
							queue_scroll = queue_scroll - 1
						end
					elseif tab == 2 and not in_search_result then
						local r_visible = math.max(0, math.floor((height - 6) / 2))
						if search_results then
							if dir == 1 and search_scroll + r_visible < #search_results then
								search_scroll = search_scroll + 1
							elseif dir == -1 and search_scroll > 0 then
								search_scroll = search_scroll - 1
							end
						end
					elseif tab == 3 and not in_changelog_item then
						local r_visible = math.max(0, math.floor((height - 6) / 2))
						if changelog_results then
							if dir == 1 and changelog_scroll + r_visible < #changelog_results then
								changelog_scroll = changelog_scroll + 1
							elseif dir == -1 and changelog_scroll > 0 then
								changelog_scroll = changelog_scroll - 1
							end
						end
					end
					redrawScreen()
				end,
				function()
					-- Mouse drag for volume
					local event, button, x, y = os.pullEvent("mouse_drag")
					if button == 1 and tab == 1 and not in_search_result then
						if y == 10 then
							local slider_start = 4
							local slider_end = width - 6
							local slider_len = slider_end - slider_start
							if x >= slider_start and x <= slider_end then
								volume = math.max(0, math.min(3, (x - slider_start) / slider_len * 3))
								redrawScreen()
							end
						end
					end
				end,
				function()
					-- Keyboard handler
					local event, key = os.pullEvent("key")

					-- Tab navigation
					if not in_search_result and not in_changelog_item then
						if key == keys.left then
							tab = tab > 1 and tab - 1 or 3
							if tab == 3 and changelog_results == nil and last_changelog_url == nil then
								last_changelog_url = api_base_url .. "?v=" .. version .. "&changelogs=1"
								http.request(last_changelog_url)
								changelog_error = false
							end
							redrawScreen()
						elseif key == keys.right then
							tab = tab < 3 and tab + 1 or 1
							if tab == 3 and changelog_results == nil and last_changelog_url == nil then
								last_changelog_url = api_base_url .. "?v=" .. version .. "&changelogs=1"
								http.request(last_changelog_url)
								changelog_error = false
							end
							redrawScreen()
						end
					end

					-- Volume keys
					if key == keys.equals or key == keys.numPadAdd then
						volume = math.min(3, volume + 0.15)
						redrawScreen()
					elseif key == keys.minus or key == keys.numPadSubtract then
						volume = math.max(0, volume - 0.15)
						redrawScreen()
					end

					-- Q to go back / cancel
					if key == keys.q then
						if in_search_result then
							in_search_result = false
							redrawScreen()
						elseif in_changelog_item then
							in_changelog_item = false
							redrawScreen()
						end
					end

					-- Space to play/pause
					if key == keys.space and tab == 1 then
						if playing then
							playing = false
							for _, speaker in ipairs(speakers) do
								speaker.stop()
								os.queueEvent("playback_stopped")
							end
							playing_id = nil
							is_loading = false
							is_error = false
							clearVisualizer()
							os.queueEvent("audio_update")
						elseif now_playing ~= nil then
							playing_id = nil
							playing = true
							is_error = false
							os.queueEvent("audio_update")
						elseif #queue > 0 then
							now_playing = queue[1]
							table.remove(queue, 1)
							playing_id = nil
							playing = true
							is_error = false
							os.queueEvent("audio_update")
						end
						redrawScreen()
					end

					-- N to skip
					if key == keys.n and tab == 1 then
						if now_playing ~= nil or #queue > 0 then
							is_error = false
							if playing then
								for _, speaker in ipairs(speakers) do
									speaker.stop()
									os.queueEvent("playback_stopped")
								end
							end
							if #queue > 0 then
								if looping == 1 then
									table.insert(queue, now_playing)
								end
								now_playing = queue[1]
								table.remove(queue, 1)
								playing_id = nil
							else
								now_playing = nil
								playing = false
								is_loading = false
								is_error = false
								playing_id = nil
								clearVisualizer()
							end
							os.queueEvent("audio_update")
							redrawScreen()
						end
					end

					-- S to search (when on search tab)
					if key == keys.s and tab == 2 and not in_search_result then
						paintutils.drawFilledBox(4, 3, width - 1, 3, colors.white)
						waiting_for_input = true
					end
				end,
				function()
					-- Timer for animation
					local event, id = os.pullEvent("timer")
					if id == anim_timer then
						anim_frame = anim_frame + 1
						anim_timer = os.startTimer(0.5)
						if is_loading or (last_search_url and not search_results) or (last_changelog_url and not changelog_results) then
							redrawScreen()
						end
						if playing and now_playing then
							redrawScreen()
						end
					end
				end,
				function()
					local event = os.pullEvent("redraw_screen")
					redrawScreen()
				end
			)
		end
	end
end

function handleNowPlayingClick(x, y)
	local has_content = now_playing ~= nil or #queue > 0
	local btn_row = 9

	if y == btn_row then
		-- Play/Stop button (starts at x=2)
		local cx = 2
		local stop_w = playing and 6 or 6
		if x >= cx and x < cx + stop_w then
			if playing then
				flashButton(cx, btn_row, "Stop")
				playing = false
				for _, speaker in ipairs(speakers) do
					speaker.stop()
					os.queueEvent("playback_stopped")
				end
				playing_id = nil
				is_loading = false
				is_error = false
				clearVisualizer()
				os.queueEvent("audio_update")
			elseif now_playing ~= nil then
				flashButton(cx, btn_row, "Play")
				playing_id = nil
				playing = true
				is_error = false
				os.queueEvent("audio_update")
			elseif #queue > 0 then
				flashButton(cx, btn_row, "Play")
				now_playing = queue[1]
				table.remove(queue, 1)
				playing_id = nil
				playing = true
				is_error = false
				os.queueEvent("audio_update")
			end
			return
		end
		cx = cx + stop_w + 1

		-- Skip button
		local skip_w = 4
		if x >= cx and x < cx + skip_w then
			if has_content then
				flashButton(cx, btn_row, ">>")
				is_error = false
				if playing then
					for _, speaker in ipairs(speakers) do
						speaker.stop()
						os.queueEvent("playback_stopped")
					end
				end
				if #queue > 0 then
					if looping == 1 then
						table.insert(queue, now_playing)
					end
					now_playing = queue[1]
					table.remove(queue, 1)
					playing_id = nil
				else
					now_playing = nil
					playing = false
					is_loading = false
					is_error = false
					playing_id = nil
					clearVisualizer()
				end
				os.queueEvent("audio_update")
			end
			return
		end
		cx = cx + skip_w + 1

		-- Loop button
		local loop_w = looping == 0 and 6 or 5
		if x >= cx and x < cx + loop_w then
			looping = (looping + 1) % 3
			return
		end
		cx = cx + loop_w + 1

		-- Shuffle button
		if x >= cx and x < cx + 5 then
			shuffled = not shuffled
			if shuffled and #queue > 1 then
				shuffleQueue()
			end
			return
		end
	end

	-- Volume slider click
	if y == 10 then
		local slider_start = 4
		local slider_end = width - 6
		local slider_len = slider_end - slider_start
		if x >= slider_start and x <= slider_end then
			volume = math.max(0, math.min(3, (x - slider_start) / slider_len * 3))
		end
	end

	-- Clear queue button
	if y == 11 and #queue > 0 then
		local clr_label = "Clear"
		local clr_x = width - #clr_label - 2
		if x >= clr_x and x < clr_x + #clr_label + 2 then
			flashButton(clr_x, 11, clr_label)
			queue = {}
			queue_scroll = 0
		end
	end

	-- Queue item click (remove)
	if y >= 12 and #queue > 0 then
		local q_visible = math.max(0, math.floor((height - 13) / 2))
		for i = 1, q_visible do
			local idx = i + queue_scroll
			if idx > #queue then break end
			local item_y = 12 + (i - 1) * 2
			if y == item_y or y == item_y + 1 then
				table.remove(queue, idx)
				if queue_scroll > 0 and queue_scroll >= #queue then
					queue_scroll = math.max(0, #queue - q_visible)
				end
				break
			end
		end
	end
end

function handleSearchClick(x, y)
	-- Search bar click
	if y == 3 and x >= 4 and x <= width - 1 then
		paintutils.drawFilledBox(4, 3, width - 1, 3, colors.white)
		waiting_for_input = true
		return
	end

	-- Search result click
	if search_results then
		local r_start = 5
		local r_visible = math.max(0, math.floor((height - r_start - 1) / 2))
		for i = 1, r_visible do
			local idx = i + search_scroll
			if idx > #search_results then break end
			local item_y = r_start + (i - 1) * 2
			if y == item_y or y == item_y + 1 then
				in_search_result = true
				clicked_result = idx
				return
			end
		end
	end
end

function handleSearchResultMenuClick(x, y)
	if not search_results or not search_results[clicked_result] then
		in_search_result = false
		return
	end
	local item = search_results[clicked_result]

	if y == 6 then
		-- Play now
		flashButton(2, 6, "Play now")
		in_search_result = false
		for _, speaker in ipairs(speakers) do
			speaker.stop()
			os.queueEvent("playback_stopped")
		end
		playing = true
		is_error = false
		playing_id = nil
		if item.type == "playlist" and item.playlist_items then
			now_playing = item.playlist_items[1]
			queue = {}
			for i = 2, #item.playlist_items do
				table.insert(queue, item.playlist_items[i])
			end
		else
			now_playing = item
		end
		tab = 1
		os.queueEvent("audio_update")
	elseif y == 8 then
		-- Play next
		flashButton(2, 8, "Play next")
		in_search_result = false
		if item.type == "playlist" and item.playlist_items then
			for i = #item.playlist_items, 1, -1 do
				table.insert(queue, 1, item.playlist_items[i])
			end
		else
			table.insert(queue, 1, item)
		end
		os.queueEvent("audio_update")
	elseif y == 10 then
		-- Add to queue
		flashButton(2, 10, "Add to queue")
		in_search_result = false
		if item.type == "playlist" and item.playlist_items then
			for i = 1, #item.playlist_items do
				table.insert(queue, item.playlist_items[i])
			end
		else
			table.insert(queue, item)
		end
		os.queueEvent("audio_update")
	else
		-- Any other click (including y==13 Cancel, or clicking empty space) dismisses the overlay
		in_search_result = false
	end
end

function handleChangelogClick(x, y)
	if changelog_results then
		local r_start = 5
		local r_visible = math.max(0, math.floor((height - r_start - 1) / 2))
		for i = 1, r_visible do
			local idx = i + changelog_scroll
			if idx > #changelog_results then break end
			local item_y = r_start + (i - 1) * 2
			if y == item_y or y == item_y + 1 then
				in_changelog_item = true
				clicked_changelog = idx
				return
			end
		end
	end
end

function audioLoop()
	while true do
		if playing and now_playing then
			local thisnowplayingid = now_playing.id
			if playing_id ~= thisnowplayingid then
				playing_id = thisnowplayingid
				last_download_url = api_base_url .. "?v=" .. version .. "&id=" .. textutils.urlEncode(playing_id)
				playing_status = 0
				needs_next_chunk = 1

				http.request({url = last_download_url, binary = true})
				is_loading = true
				clearVisualizer()

				os.queueEvent("redraw_screen")
				os.queueEvent("audio_update")
			elseif playing_status == 1 and needs_next_chunk == 1 then
				while true do
					local chunk = player_handle.read(size)
					if not chunk then
						if looping == 2 or (looping == 1 and #queue == 0) then
							playing_id = nil
						elseif looping == 1 and #queue > 0 then
							table.insert(queue, now_playing)
							now_playing = queue[1]
							table.remove(queue, 1)
							playing_id = nil
						else
							if #queue > 0 then
								now_playing = queue[1]
								table.remove(queue, 1)
								playing_id = nil
							else
								now_playing = nil
								playing = false
								playing_id = nil
								is_loading = false
								is_error = false
								clearVisualizer()
							end
						end

						os.queueEvent("redraw_screen")

						player_handle.close()
						needs_next_chunk = 0
						break
					else
						if start then
							chunk, start = start .. chunk, nil
							size = size + 4
						end

						buffer = decoder(chunk)

						-- Feed visualizer
						updateVisualizer(buffer)
						os.queueEvent("redraw_screen")

						local fn = {}
						for i, speaker in ipairs(speakers) do
							fn[i] = function()
								local name = peripheral.getName(speaker)
								if #speakers > 1 then
									if speaker.playAudio(buffer, volume) then
										parallel.waitForAny(
											function()
												repeat until select(2, os.pullEvent("speaker_audio_empty")) == name
											end,
											function()
												os.pullEvent("playback_stopped")
												return
											end
										)
										if not playing or playing_id ~= thisnowplayingid then
											return
										end
									end
								else
									while not speaker.playAudio(buffer, volume) do
										parallel.waitForAny(
											function()
												repeat until select(2, os.pullEvent("speaker_audio_empty")) == name
											end,
											function()
												os.pullEvent("playback_stopped")
												return
											end
										)
										if not playing or playing_id ~= thisnowplayingid then
											return
										end
									end
								end
								if not playing or playing_id ~= thisnowplayingid then
									return
								end
							end
						end

						local ok, err = pcall(parallel.waitForAll, table.unpack(fn))
						if not ok then
							needs_next_chunk = 2
							is_error = true
							break
						end

						if not playing or playing_id ~= thisnowplayingid then
							break
						end
					end
				end
				os.queueEvent("audio_update")
			end
		end

		os.pullEvent("audio_update")
	end
end

function httpLoop()
	while true do
		parallel.waitForAny(
			function()
				local event, url, handle = os.pullEvent("http_success")

				if url == last_search_url then
					search_results = textutils.unserialiseJSON(handle.readAll())
					search_scroll = 0
					os.queueEvent("redraw_screen")
				end
				if url == last_changelog_url then
					changelog_results = textutils.unserialiseJSON(handle.readAll())
					changelog_scroll = 0
					os.queueEvent("redraw_screen")
				end
				if url == last_download_url then
					is_loading = false
					player_handle = handle
					start = handle.read(4)
					size = 16 * 1024 - 4
					playing_status = 1
					os.queueEvent("redraw_screen")
					os.queueEvent("audio_update")
				end
			end,
			function()
				local event, url = os.pullEvent("http_failure")

				if url == last_search_url then
					search_error = true
					os.queueEvent("redraw_screen")
				end
				if url == last_changelog_url then
					changelog_error = true
					os.queueEvent("redraw_screen")
				end
				if url == last_download_url then
					is_loading = false
					is_error = true
					playing = false
					playing_id = nil
					clearVisualizer()
					os.queueEvent("redraw_screen")
					os.queueEvent("audio_update")
				end
			end
		)
	end
end

parallel.waitForAny(uiLoop, audioLoop, httpLoop)
