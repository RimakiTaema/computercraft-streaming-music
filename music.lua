local api_base_url = "SetMe"

-- Versioning:
-- X.X.1 => Minor change (usually no forced client update unless bugfix needed)
-- X.1.X => Medium change (client update recommended if behavior changes)
-- 1.X.X => Major change (client update required)
local version = "4.1.1"
local DOWNLOAD_REQUEST_TIMEOUT = 60

local width, height = term.getSize()
local tab = 1 -- 1=Player 2=Queue 3=Search 4=Settings

-- Search state
local last_search = nil
local last_search_url = nil
local search_results = nil
local search_error = false
local search_error_message = nil
local in_search_result = false
local clicked_result = nil
local search_scroll = 0
local search_ignore_next_s_char = false
local local_tracks = nil
local local_scroll = 0
local local_status = nil
local local_download_url = nil
local local_download_path = nil
local LOCAL_MUSIC_DIR = "music"

-- Changelog state
local changelog_results = nil
local changelog_error = false
local last_changelog_url = nil
local in_changelog_item = false
local clicked_changelog = nil
local changelog_scroll = 0
local changelog_body_scroll = 0

-- Queue state
local queue_scroll = 0

-- Settings scroll
local settings_scroll = 0

-- Playback
local playing = false
local queue = {}
local now_playing = nil
local looping = 0 -- 0=off, 1=queue, 2=single
local volume = 1.0
local MAX_VOLUME = 2.0
local shuffled = false

local playing_id = nil
local last_download_url = nil
local playing_status = 0
local is_loading = false
local is_error = false
local waiting_for_input = false
local resume_positions = {}
local current_played_seconds = 0
local DFPWM_BYTES_PER_SECOND = 6000

-- Audio
local player_handle = nil
local start = nil
local size = nil
local decoder = require "cc.audio.dfpwm".make_decoder()
local needs_next_chunk = 0

-- Visualizer
local viz_bars = {}
local viz_target_bars = {}
local viz_bar_count = 0
local VIZ_SMOOTH_DECAY = 0.85
local VIZ_RISE_SPEED = 0.5
local VIZ_TIMER_INTERVAL = 0.05
local viz_timer = nil
local VIZ_CHARS = { "\x8f", "\x8f", "\x83", "\x83", "\x8c", "\x8c", "\x8c", "\x7f" }

-- Animation
local anim_frame = 0
local anim_timer = os.startTimer(0.5)

-- Layout tiers
local LAYOUT_COMPACT = 1
local LAYOUT_NORMAL = 2
local LAYOUT_WIDE = 3
local layout_mode = LAYOUT_NORMAL

-- Colors
local C_BG = colors.black
local C_TAB_BG = colors.gray
local C_TAB_SEL = colors.cyan
local C_TAB_FG = colors.lightGray
local C_TITLE = colors.white
local C_ARTIST = colors.lightGray
local C_ACCENT = colors.cyan
local C_BTN_BG = colors.gray
local C_BTN_ACT = colors.cyan
local C_BTN_DIS = colors.lightGray
local C_VIZ = colors.cyan
local C_VIZ2 = colors.purple
local C_ERROR = colors.red
local C_LOADING = colors.yellow
local C_SEARCH_BG = colors.gray
local C_SEARCH_FG = colors.white
local C_SEARCH_PH = colors.lightGray
local C_DIM = colors.gray

-- Speakers (local)
local speakers = { peripheral.find("speaker") }

-- Modem / network speakers
local modem = peripheral.find("modem")
local has_modem = modem ~= nil
local network_speakers = {} -- { id=number, label=string }
local STREAM_PROTOCOL = "music_stream"

if #speakers == 0 and not has_modem then
	error("No speakers or modem attached.", 0)
end

if has_modem then
	rednet.open(peripheral.getName(modem))
end

-- Monitor auto-detect: use monitor as primary display if attached
local monitor = peripheral.find("monitor")
local original_term = term.current()
local has_monitor = false
if monitor then
	local best_scale = nil
	local scales = { 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5 }
	for _, s in ipairs(scales) do
		monitor.setTextScale(s)
		local mw, mh = monitor.getSize()
		if mw >= 29 and mh >= 12 then
			best_scale = s
			break
		end
	end
	if best_scale then
		monitor.setTextScale(best_scale)
		has_monitor = true
		term.redirect(monitor)
		width, height = monitor.getSize()
	end
end

-- Unified click handler: accepts both mouse_click and monitor_touch
local function pullClick()
	while true do
		local event, p1, p2, p3 = os.pullEvent()
		if event == "mouse_click" then
			return event, p1, p2, p3
		elseif event == "monitor_touch" and has_monitor then
			return event, 1, p2, p3
		end
	end
end

-- Compute layout mode
local function computeLayout()
	if width < 40 or height < 16 then
		layout_mode = LAYOUT_COMPACT
	elseif width >= 80 then
		layout_mode = LAYOUT_WIDE
	else
		layout_mode = LAYOUT_NORMAL
	end
end
computeLayout()

if api_base_url == "SetMe" then
	error("Set api_base_url before using. Edit with: edit music", 0)
end

if string.sub(api_base_url, -1) ~= "/" then
	api_base_url = api_base_url .. "/"
end

-- ============================================================
-- HELPERS
-- ============================================================

local function ellipsize(text, max_len)
	if not text then return "" end
	if max_len < 4 then return string.sub(text, 1, max_len) end
	if #text <= max_len then return text end
	return string.sub(text, 1, max_len - 3) .. "..."
end

local function getTrackKey(track)
	if not track then return nil end
	if track.local_path then return "local:" .. track.local_path end
	if track.download_url then return "url:" .. track.download_url end
	if track.id then return "id:" .. track.id end
	return nil
end

local function makeDownloadUrl(track)
	if not track then return nil end
	if track.download_url then
		return api_base_url .. "?v=" .. version .. "&url=" .. textutils.urlEncode(track.download_url)
	elseif track.id then
		return api_base_url .. "?v=" .. version .. "&id=" .. textutils.urlEncode(track.id)
	end
	return nil
end

local function sanitizeFileName(name)
	name = name or "track"
	name = string.gsub(name, "[/\\:*?\"<>|]", "_")
	name = string.gsub(name, "%s+", " ")
	name = string.gsub(name, "^%s+", "")
	name = string.gsub(name, "%s+$", "")
	if #name == 0 then name = "track" end
	return string.sub(name, 1, 48)
end

local function ensureLocalMusicDir()
	if not fs.exists(LOCAL_MUSIC_DIR) then
		fs.makeDir(LOCAL_MUSIC_DIR)
	end
end

local function formatBytes(bytes)
	if not bytes then return "N/A" end
	local units = {"B","KB","MB","GB"}
	local b = tonumber(bytes)
	local i = 1
	while b >= 1024 and i < #units do
		b = b / 1024
		i = i + 1
	end
	return string.format("%.1f %s", b, units[i])
end

local function getFreeSpaceString()
	if fs and fs.getFreeSpace then
		local ok, free = pcall(fs.getFreeSpace)
		if ok and free then
			return "Storage: " .. formatBytes(free) .. " free"
		end
	end
	return "Storage: N/A"
end

local function loadLocalTracks()
	ensureLocalMusicDir()
	local_tracks = {}
	for _, file in ipairs(fs.list(LOCAL_MUSIC_DIR)) do
		local path = fs.combine(LOCAL_MUSIC_DIR, file)
		if not fs.isDir(path) and string.lower(file):match("%.dfpwm$") then
			local name = string.gsub(file, "%.dfpwm$", "")
			table.insert(local_tracks, {
				id = "local:" .. path,
				name = name,
				artist = "Local DFPWM",
				platform = "local",
				local_path = path,
			})
		end
	end
	table.sort(local_tracks, function(a, b)
		return string.lower(a.name or "") < string.lower(b.name or "")
	end)
end

local function makeLocalTrackFromResult(result)
	if not result then return nil end
	if result.local_path then
		return {
			id = result.id,
			name = result.name,
			artist = result.artist,
			platform = result.platform,
			local_path = result.local_path,
		}
	end
	return {
		id = result.id,
		name = result.name,
		artist = result.artist,
		platform = result.platform,
		download_url = result.download_url,
	}
end

local function startLocalDownload(result)
	local track = makeLocalTrackFromResult(result)
	local url = makeDownloadUrl(track)
	if not url then
		local_status = "Cannot save this result"
		return false
	end

	ensureLocalMusicDir()
	local base_name = sanitizeFileName((track.artist and #track.artist > 0 and (track.artist .. " - ") or "") .. (track.name or "track"))
	local path = fs.combine(LOCAL_MUSIC_DIR, base_name .. ".dfpwm")
	local i = 2
	while fs.exists(path) do
		path = fs.combine(LOCAL_MUSIC_DIR, base_name .. " " .. i .. ".dfpwm")
		i = i + 1
	end

	local_download_url = url .. "&save=" .. tostring(math.floor(os.clock() * 1000))
	local_download_path = path
	local_status = "Saving " .. base_name .. " (" .. getFreeSpaceString() .. ")"
	http.request({ url = local_download_url, binary = true, timeout = DOWNLOAD_REQUEST_TIMEOUT })
	return true
end

local function saveResumePosition()
	local key = getTrackKey(now_playing)
	if key and current_played_seconds > 0 then
		resume_positions[key] = current_played_seconds
	end
end

local function resetResumePosition(track)
	local key = getTrackKey(track)
	if key then resume_positions[key] = nil end
	if now_playing == track then current_played_seconds = 0 end
end

local function formatTime(seconds)
	seconds = math.max(0, math.floor(seconds or 0))
	local mins = math.floor(seconds / 60)
	local secs = seconds % 60
	return string.format("%d:%02d", mins, secs)
end

local function splitWrappedLines(text, max_width)
	local lines = {}
	max_width = math.max(1, max_width)
	text = text or ""

	for raw_line in string.gmatch(text .. "\n", "([^\n]*)\n") do
		local line = raw_line
		if #line == 0 then
			table.insert(lines, "")
		else
			while #line > max_width do
				local cut = max_width
				for i = max_width, 1, -1 do
					if string.sub(line, i, i) == " " then
						cut = i - 1
						break
					end
				end
				if cut < 1 then cut = max_width end
				table.insert(lines, string.sub(line, 1, cut))
				line = string.sub(line, cut + 1)
				while string.sub(line, 1, 1) == " " do
					line = string.sub(line, 2)
				end
			end
			table.insert(lines, line)
		end
	end

	return lines
end

local function getChangelogBodyMaxScroll()
	if not clicked_changelog then return 0 end
	local body_lines = splitWrappedLines(clicked_changelog.body or "", width - 4)
	local body_y = 6
	local body_height = math.max(1, height - body_y - 1)
	return math.max(0, #body_lines - body_height)
end

local function closePlayerHandle()
	if player_handle then
		pcall(function() player_handle.close() end)
		player_handle = nil
	end
	playing_status = 0
	needs_next_chunk = 0
end

local function centerText(text, y, fg, bg)
	term.setCursorPos(math.floor((width - #text) / 2) + 1, y)
	term.setTextColor(fg or C_TITLE)
	term.setBackgroundColor(bg or C_BG)
	term.write(text)
end

local function drawButton(x, y, label, active, disabled)
	local bg = active and C_BTN_ACT or C_BTN_BG
	local fg = disabled and C_BTN_DIS or C_TITLE
	term.setCursorPos(x, y)
	term.setBackgroundColor(bg)
	term.setTextColor(fg)
	local txt = " " .. label .. " "
	term.write(txt)
	return #txt
end

local function flashButton(x, y, label)
	term.setCursorPos(x, y)
	term.setBackgroundColor(colors.white)
	term.setTextColor(colors.black)
	term.write(" " .. label .. " ")
	sleep(0.15)
end

local function drawHintBar(text)
	term.setCursorPos(1, height)
	term.setBackgroundColor(C_TAB_BG)
	term.setTextColor(C_TAB_FG)
	term.write((" "):rep(width))
	term.setCursorPos(2, height)
	term.write(ellipsize(text, width - 2))
end

local function drawSearchInputLine(input, input_y)
	local tw = select(1, term.getSize())
	term.setCursorPos(1, input_y)
	term.setBackgroundColor(C_ACCENT)
	term.setTextColor(colors.black)
	term.clearLine()
	term.write(ellipsize(input, tw - 1))
end

local function readStickySearchInput(input_y)
	local input = ""
	drawSearchInputLine(input, input_y)

	while true do
		local event, p1 = os.pullEvent()
		if event == "char" then
			if search_ignore_next_s_char and string.lower(p1) == "s" then
				search_ignore_next_s_char = false
			else
				search_ignore_next_s_char = false
				input = input .. p1
				drawSearchInputLine(input, input_y)
			end
		elseif event == "paste" then
			search_ignore_next_s_char = false
			input = input .. p1
			drawSearchInputLine(input, input_y)
		elseif event == "key" then
			search_ignore_next_s_char = false
			if p1 == keys.enter or p1 == keys.numPadEnter then
				return input
			elseif p1 == keys.backspace and #input > 0 then
				input = string.sub(input, 1, #input - 1)
				drawSearchInputLine(input, input_y)
			end
		elseif event == "term_resize" then
			width, height = term.getSize()
			drawSearchInputLine(input, input_y)
		end
	end
end

local function loadingText()
	local dots = string.rep(".", (anim_frame % 3) + 1)
	return "Loading" .. dots .. string.rep(" ", 3 - #dots)
end

local function getPlayerLayout()
	local ctrl_y = math.max(7, height - 2)
	local info_y = math.max(5, ctrl_y - 1)
	local viz_y = 3
	local viz_height = math.max(3, info_y - viz_y - 1)
	return viz_y, viz_height, info_y, ctrl_y
end

-- Fisher-Yates shuffle
local function shuffleQueue()
	if not shuffled or #queue < 2 then return end
	for i = #queue, 2, -1 do
		local j = math.random(1, i)
		queue[i], queue[j] = queue[j], queue[i]
	end
end

-- Platform icon helper
local function platformIcon(platform)
	if platform == "soundcloud" then return "\x06"
	elseif platform == "spotify" then return "\x04"
	elseif platform == "direct" then return "\x10"
	elseif platform == "local" then return "\x0f"
	else return "\x0e" end -- youtube / default
end

-- ============================================================
-- VISUALIZER
-- ============================================================

local function initVisualizer()
	viz_bar_count = math.max(1, width - 4)
	viz_bars = {}
	viz_target_bars = {}
	for i = 1, viz_bar_count do
		viz_bars[i] = 0
		viz_target_bars[i] = 0
	end
end
initVisualizer()

local function updateVisualizer(audio_buffer)
	if not audio_buffer or #audio_buffer == 0 then return end
	local bars = viz_bar_count
	local samples_per_bar = math.floor(#audio_buffer / bars)
	if samples_per_bar < 1 then samples_per_bar = 1 end

	local _, viz_height = getPlayerLayout()
	for i = 1, bars do
		local sum = 0
		local start_idx = (i - 1) * samples_per_bar + 1
		local end_idx = math.min(i * samples_per_bar, #audio_buffer)
		for j = start_idx, end_idx do
			local val = audio_buffer[j]
			if val then sum = sum + math.abs(val) end
		end
		local avg = sum / math.max(1, end_idx - start_idx + 1)
		local normalized = math.min(1, avg / 80)
		viz_target_bars[i] = normalized * (viz_height * 2)
	end
end

local function tickVisualizer()
	local changed = false
	for i = 1, viz_bar_count do
		local target = viz_target_bars[i] or 0
		local current = viz_bars[i] or 0
		local next_val
		if target > current then
			next_val = current + (target - current) * VIZ_RISE_SPEED
		else
			next_val = current * VIZ_SMOOTH_DECAY
		end
		if next_val < 0.05 then next_val = 0 end
		if math.abs(next_val - current) > 0.01 then changed = true end
		viz_bars[i] = next_val
	end
	return changed
end

local function clearVisualizer()
	for i = 1, viz_bar_count do
		viz_bars[i] = 0
		viz_target_bars[i] = 0
	end
end

local function drawVisualizer(y_start, bar_height)
	for i = 1, math.min(viz_bar_count, width - 4) do
		local val = viz_bars[i] or 0
		for row = 0, bar_height - 1 do
			local row_bottom = (bar_height - 1 - row) * 2
			local fill = val - row_bottom

			local x = i + 2
			local y = y_start + row
			term.setCursorPos(x, y)

			local is_top_region = row < math.floor(bar_height * 0.33)
			local fg = is_top_region and C_VIZ2 or C_VIZ

			if fill >= 2 then
				term.setTextColor(fg)
				term.setBackgroundColor(fg)
				term.write("\x7f")
			elseif fill > 0 then
				local char_idx = math.max(1, math.min(#VIZ_CHARS, math.ceil(fill / 2 * #VIZ_CHARS)))
				term.setTextColor(fg)
				term.setBackgroundColor(C_BG)
				term.write(VIZ_CHARS[char_idx] or " ")
			else
				term.setTextColor(C_BG)
				term.setBackgroundColor(C_BG)
				term.write(" ")
			end
		end
	end
end

local function drawVisualizerOnly()
	if tab ~= 1 then return end
	local viz_y, viz_height = getPlayerLayout()
	drawVisualizer(viz_y, viz_height)
end

-- ============================================================
-- TAB BAR
-- ============================================================

local function drawTabs()
	local labels = { "\x0e Player", "\x10 Queue", "\x06 Search", "\x04 Settings" }
	local tab_w = math.floor(width / 4)
	for i = 1, 4 do
		local x = (i - 1) * tab_w + 1
		local sel = (i == tab)
		term.setCursorPos(x, 1)
		term.setBackgroundColor(sel and C_BG or C_TAB_BG)
		term.setTextColor(sel and C_TAB_SEL or C_TAB_FG)
		local lbl = labels[i]
		local pad = tab_w - #lbl
		local left_pad = math.floor(pad / 2)
		local right_pad = pad - left_pad
		term.write(string.rep(" ", left_pad) .. lbl .. string.rep(" ", math.max(0, right_pad)))
		-- Underline for selected tab
		term.setCursorPos(x, 2)
		if sel then
			term.setBackgroundColor(C_ACCENT)
			term.write(string.rep(" ", tab_w))
		else
			term.setBackgroundColor(C_TAB_BG)
			term.write(string.rep(" ", tab_w))
		end
	end
	-- Fill remainder of row 1 & 2
	local remaining = width - 4 * tab_w
	if remaining > 0 then
		term.setCursorPos(4 * tab_w + 1, 1)
		term.setBackgroundColor(C_TAB_BG)
		term.write(string.rep(" ", remaining))
		term.setCursorPos(4 * tab_w + 1, 2)
		term.write(string.rep(" ", remaining))
	end
end

-- ============================================================
-- TAB 1: PLAYER
-- ============================================================

local function drawPlayer()
	local viz_y, viz_height, info_y, ctrl_y = getPlayerLayout()

	-- Visualizer
	drawVisualizer(viz_y, viz_height)

	-- Compact now-playing strip
	term.setCursorPos(1, info_y)
	term.setBackgroundColor(C_BG)
	term.setTextColor(C_DIM)
	term.clearLine()
	if now_playing then
		local status = ""
		if is_loading then
			status = "  " .. loadingText()
		elseif is_error then
			status = "  Error"
		elseif current_played_seconds > 0 then
			status = "  " .. formatTime(current_played_seconds)
		end

		local platform = now_playing.platform and (" [" .. now_playing.platform .. "]") or ""
		local title = (now_playing.name or "Unknown") .. platform
		local artist = now_playing.artist and #now_playing.artist > 0 and (" - " .. now_playing.artist) or ""
		term.setCursorPos(2, info_y)
		term.setTextColor(C_ACCENT)
		term.write(platformIcon(now_playing.platform) .. " ")
		term.setTextColor(C_TITLE)
		term.write(ellipsize(title .. artist .. status, width - 3))
	else
		centerText("Search or add a track", info_y, C_DIM)
	end

	-- Controls
	if ctrl_y <= height - 1 then
		term.setCursorPos(1, ctrl_y)
		term.setBackgroundColor(C_BG)
		term.clearLine()
		local cx = 2
		local is_playing = playing and now_playing
		cx = cx + drawButton(cx, ctrl_y, is_playing and "\x04" or "\x10", is_playing, not now_playing and #queue == 0)
		cx = cx + 1
		cx = cx + drawButton(cx, ctrl_y, ">>", false, #queue == 0 and not now_playing)
		cx = cx + 1
		local loop_labels = { [0] = "Loop", [1] = "L.Q", [2] = "L.1" }
		cx = cx + drawButton(cx, ctrl_y, loop_labels[looping], looping > 0)
		cx = cx + 1
		cx = cx + drawButton(cx, ctrl_y, "Shf", shuffled)
		if width >= 38 then
			local vol_text = " Vol " .. math.floor((volume / MAX_VOLUME) * 100) .. "%"
			term.setCursorPos(math.max(cx + 1, width - #vol_text), ctrl_y)
			term.setTextColor(C_DIM)
			term.setBackgroundColor(C_BG)
			term.write(vol_text)
		end
	end

	drawHintBar("Space:play  N:skip  +/-:vol  S:search")
end

local function getChangelogListMetrics()
	local settings_y = 4
	settings_y = settings_y + 1 -- Loop
	settings_y = settings_y + 1 -- Shuffle
	settings_y = settings_y + 2 -- Volume + spacer
	settings_y = settings_y + 1 -- Speakers header
	settings_y = settings_y + 1 -- Local row
	settings_y = settings_y + #speakers
	settings_y = settings_y + 1 + #network_speakers
	if not has_modem then settings_y = settings_y + 1 end
	settings_y = settings_y + 1 -- Spacer before changelog

	local header_y = settings_y
	local list_y = header_y + 1
	local visible = math.max(1, height - list_y - 1)
	return list_y, visible
end

local function drawChangelogDetail()
	term.setBackgroundColor(C_BG)
	term.clear()

	local cl = clicked_changelog
	if not cl then
		in_changelog_item = false
		centerText("No changelog selected", math.floor(height / 2), C_DIM)
		return
	end

	term.setCursorPos(2, 1)
	term.setTextColor(C_ACCENT)
	term.write("\x10 Changelog")

	term.setCursorPos(2, 3)
	term.setTextColor(C_TITLE)
	term.write(ellipsize(cl.title or "", width - 3))

	term.setCursorPos(2, 4)
	term.setTextColor(C_DIM)
	term.write(cl.date or "")
	if now_playing then
		local play_time = "Play " .. formatTime(current_played_seconds)
		term.setCursorPos(math.max(2, width - #play_time), 4)
		term.setTextColor(C_ACCENT)
		term.write(play_time)
	end

	local body_lines = splitWrappedLines(cl.body or "", width - 4)
	local body_y = 6
	local body_height = math.max(1, height - body_y - 1)
	local max_scroll = math.max(0, #body_lines - body_height)
	if changelog_body_scroll > max_scroll then changelog_body_scroll = max_scroll end

	for i = 1, body_height do
		local idx = changelog_body_scroll + i
		if idx > #body_lines then break end
		term.setCursorPos(2, body_y + i - 1)
		term.setTextColor(C_ARTIST)
		term.write(ellipsize(body_lines[idx], width - 3))
	end

	if changelog_body_scroll > 0 then
		term.setCursorPos(width, body_y)
		term.setTextColor(C_ACCENT)
		term.write("\x1e")
	end
	if changelog_body_scroll < max_scroll then
		term.setCursorPos(width, height - 2)
		term.setTextColor(C_ACCENT)
		term.write("\x1f")
	end

	drawButton(2, height - 1, "Back", false)
	term.setBackgroundColor(C_BG)
	drawHintBar("Scroll:read  Q:back")
end

-- ============================================================
-- TAB 2: QUEUE
-- ============================================================

local function drawQueueTab()
	-- Header
	term.setCursorPos(2, 3)
	term.setTextColor(C_TITLE)
	term.setBackgroundColor(C_BG)
	term.write("Queue (" .. #queue .. " items)")

	-- Buttons on header row
	local bx = width - 1
	local shf_w = drawButton(bx - 5, 3, "Shf", shuffled)
	drawButton(bx - 5 - shf_w - 1, 3, "Clr", false, #queue == 0)
	term.setBackgroundColor(C_BG)

	if #queue == 0 then
		centerText("Queue is empty", math.floor(height / 2), C_DIM)
		centerText("Search and add tracks", math.floor(height / 2) + 1, C_DIM)
		drawHintBar("Go to Search tab to find music")
		return
	end

	-- Queue list
	local list_start = 5
	local list_end = height - 2

	if layout_mode == LAYOUT_WIDE then
		-- Single-row format
		local visible = list_end - list_start + 1
		for i = 1, visible do
			local idx = i + queue_scroll
			if idx > #queue then break end
			local item = queue[idx]
			local y = list_start + i - 1
			local num_str = string.format("%2d. ", idx)
			term.setCursorPos(2, y)
			term.setTextColor(C_DIM)
			term.write(num_str)
			term.setTextColor(C_TITLE)
			local name = ellipsize(item.name or "Unknown", math.floor(width * 0.5))
			term.write(name)
			term.setTextColor(C_ARTIST)
			term.write(" " .. ellipsize(item.artist or "", width - 2 - #num_str - #name - 2))
		end
		if queue_scroll > 0 then
			term.setCursorPos(width, list_start)
			term.setTextColor(C_ACCENT)
			term.setBackgroundColor(C_BG)
			term.write("\x1e")
		end
		if queue_scroll + visible < #queue then
			term.setCursorPos(width, list_end)
			term.setTextColor(C_ACCENT)
			term.setBackgroundColor(C_BG)
			term.write("\x1f")
		end
	else
		-- Two-row format
		local visible = math.max(1, math.floor((list_end - list_start + 1) / 2))
		for i = 1, visible do
			local idx = i + queue_scroll
			if idx > #queue then break end
			local item = queue[idx]
			local y = list_start + (i - 1) * 2
			local num_str = string.format("%d.", idx)
			term.setCursorPos(2, y)
			term.setTextColor(C_DIM)
			term.write(num_str .. " ")
			term.setTextColor(C_TITLE)
			term.write(ellipsize(item.name or "Unknown", width - 4 - #num_str))
			term.setCursorPos(4 + #num_str, y + 1)
			term.setTextColor(C_ARTIST)
			term.write(ellipsize(item.artist or "", width - 5 - #num_str))
		end
		if queue_scroll > 0 then
			term.setCursorPos(width, list_start)
			term.setTextColor(C_ACCENT)
			term.setBackgroundColor(C_BG)
			term.write("\x1e")
		end
		if queue_scroll + visible < #queue then
			term.setCursorPos(width, list_end)
			term.setTextColor(C_ACCENT)
			term.setBackgroundColor(C_BG)
			term.write("\x1f")
		end
	end

	drawHintBar("Click item to remove  Scroll:navigate")
end

-- ============================================================
-- TAB 3: SEARCH
-- ============================================================

local function drawSearch()
	-- Search bar
	term.setCursorPos(2, 3)
	term.setTextColor(C_ACCENT)
	term.setBackgroundColor(C_BG)
	term.write("\x06 ")
	local bar_start = 4
	local bar_end = width - 1
	local bar_width = bar_end - bar_start + 1
	local search_focused = waiting_for_input
	term.setCursorPos(bar_start, 3)
	term.setBackgroundColor(search_focused and C_ACCENT or C_SEARCH_BG)
	term.write(string.rep(" ", bar_width))
	term.setCursorPos(bar_start + 1, 3)
	if search_focused then
		term.setTextColor(colors.black)
		term.write(ellipsize("> type search, then Enter", bar_width - 2))
	elseif last_search and #last_search > 0 then
		term.setTextColor(C_SEARCH_FG)
		term.write(ellipsize(last_search, bar_width - 2))
	else
		term.setTextColor(C_SEARCH_PH)
		term.write("Search or paste URL...")
	end
	term.setBackgroundColor(C_BG)

	-- Results
	if not search_results then
		if last_search_url and not search_error then
			centerText(loadingText(), math.floor(height / 2), C_LOADING)
		elseif search_error then
			centerText("Search failed", math.floor(height / 2), C_ERROR)
			if search_error_message then
				centerText(ellipsize(search_error_message, width - 4), math.floor(height / 2) + 1, C_DIM)
			end
		elseif not last_search then
			if not local_tracks then loadLocalTracks() end
			term.setCursorPos(2, 5)
			term.setTextColor(C_ACCENT)
			term.setBackgroundColor(C_BG)
			term.write("\x0f Local music/")
				-- Show free storage and optional status line
				term.setCursorPos(2, 6)
				term.setTextColor(C_DIM)
				term.write(ellipsize(getFreeSpaceString(), width - 3))
				if local_status then
					term.setCursorPos(2, 7)
					term.setTextColor(C_DIM)
					term.write(ellipsize(local_status, width - 3))
				end
				if #local_tracks == 0 then
				centerText("Search YouTube, SoundCloud, Spotify", math.floor(height / 2), C_DIM)
				centerText("or save DFPWM tracks into music/", math.floor(height / 2) + 1, C_DIM)
			else
					local list_start = local_status and 8 or 7
				local list_end = height - 2
				local visible = list_end - list_start + 1
				for i = 1, visible do
					local idx = i + local_scroll
					if idx > #local_tracks then break end
					local item = local_tracks[idx]
					local y = list_start + i - 1
					local row_bg = (i % 2 == 0) and C_BG or colors.gray
					term.setCursorPos(1, y)
					term.setBackgroundColor(row_bg)
					term.write(string.rep(" ", width))
					term.setCursorPos(2, y)
					term.setTextColor(C_ACCENT)
					term.setBackgroundColor(row_bg)
					term.write(platformIcon(item.platform) .. " ")
					term.setTextColor(C_TITLE)
					term.write(ellipsize(item.name or "Unknown", math.floor(width * 0.55)))
					term.setTextColor(C_ARTIST)
					term.write(" " .. ellipsize(item.artist or "", width - 5 - #(item.name or "")))
				end
			end
		end
		drawHintBar(search_focused and "Typing on computer keyboard  Enter:search" or "S:search  R:refresh local")
		return
	end

	if #search_results == 0 then
		centerText("No results found", math.floor(height / 2), C_DIM)
		drawHintBar("S:search  Click bar to type")
		return
	end

	-- Search result menu overlay
	if in_search_result and clicked_result then
		local r = clicked_result
		term.setBackgroundColor(C_BG)
		for y = 3, height - 1 do
			term.setCursorPos(1, y)
			term.write(string.rep(" ", width))
		end

		local icon = platformIcon(r.platform)
		centerText(icon .. " " .. ellipsize(r.name or "Unknown", width - 6), 4, C_TITLE)
		centerText(ellipsize(r.artist or "", width - 4), 5, C_ARTIST)

		if r.platform then
			centerText("[" .. (r.platform or "youtube") .. "]", 6, C_DIM)
		end

		local menu_y = 8
		drawButton(math.floor(width / 2) - 6, menu_y, "Play now", false)
		term.setBackgroundColor(C_BG)
		drawButton(math.floor(width / 2) - 6, menu_y + 2, "Play next", false)
		term.setBackgroundColor(C_BG)
		drawButton(math.floor(width / 2) - 6, menu_y + 4, "Add to queue", false)
		term.setBackgroundColor(C_BG)
		if not r.local_path and r.type ~= "playlist" then
			drawButton(math.floor(width / 2) - 6, menu_y + 6, "Save local", false)
			term.setBackgroundColor(C_BG)
		end
		drawButton(math.floor(width / 2) - 6, menu_y + 8, "Cancel", false)
		term.setBackgroundColor(C_BG)

		drawHintBar("Q:back")
		return
	end

	-- Result list
	local list_start = 5
	local list_end = height - 2

	if layout_mode == LAYOUT_WIDE then
		local visible = list_end - list_start + 1
		for i = 1, visible do
			local idx = i + search_scroll
			if idx > #search_results then break end
			local item = search_results[idx]
			local y = list_start + i - 1
			local row_bg = (i % 2 == 0) and C_BG or colors.gray
			term.setCursorPos(1, y)
			term.setBackgroundColor(row_bg)
			term.write(string.rep(" ", width))
			local icon = platformIcon(item.platform)
			term.setCursorPos(2, y)
			term.setTextColor(C_ACCENT)
			term.setBackgroundColor(row_bg)
			term.write(icon .. " ")
			term.setTextColor(C_TITLE)
			local name = ellipsize(item.name or "Unknown", math.floor(width * 0.5))
			term.write(name)
			term.setTextColor(C_ARTIST)
			term.write(" " .. ellipsize(item.artist or "", width - 5 - #name))
			if item.type == "playlist" then
				term.setCursorPos(width - 3, y)
				term.setTextColor(C_DIM)
				term.write("[PL]")
			end
		end
	else
		local visible = math.max(1, math.floor((list_end - list_start + 1) / 2))
		for i = 1, visible do
			local idx = i + search_scroll
			if idx > #search_results then break end
			local item = search_results[idx]
			local y = list_start + (i - 1) * 2
			local row_bg = (i % 2 == 0) and C_BG or colors.gray
			term.setCursorPos(1, y)
			term.setBackgroundColor(row_bg)
			term.write(string.rep(" ", width))
			if y + 1 <= list_end then
				term.setCursorPos(1, y + 1)
				term.write(string.rep(" ", width))
			end
			local icon = platformIcon(item.platform)
			if item.type == "playlist" then icon = "\x10" end
			term.setCursorPos(2, y)
			term.setTextColor(C_ACCENT)
			term.setBackgroundColor(row_bg)
			term.write(icon .. " ")
			term.setTextColor(C_TITLE)
			term.write(ellipsize(item.name or "Unknown", width - 4))
			term.setCursorPos(4, y + 1)
			term.setTextColor(C_ARTIST)
			term.setBackgroundColor(row_bg)
			local artist_text = item.artist or ""
			if item.type == "playlist" and item.playlist_items then
				artist_text = artist_text .. " (" .. #item.playlist_items .. " tracks)"
			end
			term.write(ellipsize(artist_text, width - 5))
		end
	end

	-- Scroll indicators
	if search_scroll > 0 then
		term.setCursorPos(width, list_start)
		term.setTextColor(C_ACCENT)
		term.setBackgroundColor(C_BG)
		term.write("\x1e")
	end
	local max_visible
	if layout_mode == LAYOUT_WIDE then
		max_visible = list_end - list_start + 1
	else
		max_visible = math.max(1, math.floor((list_end - list_start + 1) / 2))
	end
	if search_scroll + max_visible < #search_results then
		term.setCursorPos(width, list_end)
		term.setTextColor(C_ACCENT)
		term.setBackgroundColor(C_BG)
		term.write("\x1f")
	end

	drawHintBar(search_focused and "Typing on computer keyboard  Enter:search" or "Click result to play/queue  S:search  Scroll:navigate")
end

-- ============================================================
-- TAB 4: SETTINGS
-- ============================================================

local function drawSettings()
	local y = 3

	-- Playback settings
	term.setCursorPos(2, y)
	term.setTextColor(C_ACCENT)
	term.setBackgroundColor(C_BG)
	term.write("\x04 Playback")
	y = y + 1

	-- Loop
	term.setCursorPos(4, y)
	term.setTextColor(C_ARTIST)
	term.write("Loop: ")
	local loop_labels = { [0] = "Off", [1] = "Queue", [2] = "Single" }
	drawButton(10, y, loop_labels[looping], looping > 0)
	term.setBackgroundColor(C_BG)
	y = y + 1

	-- Shuffle
	term.setCursorPos(4, y)
	term.setTextColor(C_ARTIST)
	term.write("Shf:  ")
	drawButton(10, y, shuffled and "On" or "Off", shuffled)
	term.setBackgroundColor(C_BG)
	y = y + 1

	-- Volume
	term.setCursorPos(4, y)
	term.setTextColor(C_ARTIST)
	term.write("Vol:  ")
	local slider_start = 10
	local slider_width = math.min(20, width - slider_start - 8)
	if slider_width < 4 then slider_width = 4 end
	local filled = math.floor((volume / MAX_VOLUME) * slider_width)
	term.setCursorPos(slider_start, y)
	term.setBackgroundColor(C_ACCENT)
	term.write(string.rep(" ", filled))
	term.setBackgroundColor(C_TAB_BG)
	term.write(string.rep(" ", slider_width - filled))
	term.setBackgroundColor(C_BG)
	term.setTextColor(C_TITLE)
	term.write(" " .. math.floor((volume / MAX_VOLUME) * 100) .. "%")
	y = y + 2

	-- Speakers section
	term.setCursorPos(2, y)
	term.setTextColor(C_ACCENT)
	term.write("\x0e Speakers")
	y = y + 1

	term.setCursorPos(4, y)
	term.setTextColor(C_ARTIST)
	term.write("Local: " .. #speakers)
	y = y + 1
	for _, spk in ipairs(speakers) do
		if y > height - 4 then break end
		term.setCursorPos(6, y)
		term.setTextColor(C_DIM)
		term.write("- " .. peripheral.getName(spk))
		y = y + 1
	end

	term.setCursorPos(4, y)
	term.setTextColor(C_ARTIST)
	term.write("Network: " .. #network_speakers)
	if has_modem then
		local disc_x = 4 + 10 + #tostring(#network_speakers) + 1
		drawButton(disc_x, y, "Scan", false)
		term.setBackgroundColor(C_BG)
	end
	y = y + 1
	for _, ns in ipairs(network_speakers) do
		if y > height - 4 then break end
		term.setCursorPos(6, y)
		term.setTextColor(C_DIM)
		term.write("- ID:" .. ns.id .. (ns.label and (" " .. ns.label) or ""))
		y = y + 1
	end

	if not has_modem then
		term.setCursorPos(6, y)
		term.setTextColor(C_DIM)
		term.write("(No modem attached)")
		y = y + 1
	end

	y = y + 1

	-- Changelog section
	if y < height - 2 then
		term.setCursorPos(2, y)
		term.setTextColor(C_ACCENT)
		term.write("\x10 Changelog")
		y = y + 1

		if changelog_results and #changelog_results > 0 then
			local visible = math.max(1, height - y - 1)
			local max_scroll = math.max(0, #changelog_results - visible)
			if changelog_scroll > max_scroll then changelog_scroll = max_scroll end
			for i = 1, visible do
				local idx = i + changelog_scroll
				if idx > #changelog_results then break end
				if y > height - 2 then break end
				local cl = changelog_results[idx]
				term.setCursorPos(4, y)
				term.setTextColor(C_DIM)
				term.write((cl.date or "") .. " ")
				term.setTextColor(C_TITLE)
				term.write(ellipsize(cl.title or "", width - #(cl.date or "") - 7))
				y = y + 1
			end
		elseif changelog_error then
			term.setCursorPos(4, y)
			term.setTextColor(C_ERROR)
			term.write("Failed to load changelog")
		elseif last_changelog_url then
			term.setCursorPos(4, y)
			term.setTextColor(C_LOADING)
			term.write(loadingText())
		end
	end

	drawHintBar("+/-:vol  Click changelog to view")
end

-- ============================================================
-- MAIN REDRAW
-- ============================================================

local function redrawScreen()
	if in_changelog_item then
		drawChangelogDetail()
		return
	end

	term.setBackgroundColor(C_BG)
	term.clear()
	drawTabs()

	if tab == 1 then
		drawPlayer()
	elseif tab == 2 then
		drawQueueTab()
	elseif tab == 3 then
		drawSearch()
	elseif tab == 4 then
		drawSettings()
	end
end

-- ============================================================
-- CLICK HANDLERS
-- ============================================================

local function handlePlayerClick(x, y)
	local _, _, _, ctrl_y = getPlayerLayout()

	if y == ctrl_y then
		local cx = 2
		local is_playing = playing and now_playing

		-- Play/Stop button
		local btn_label = is_playing and "\x04" or "\x10"
		local btn_w = #btn_label + 2
		if x >= cx and x < cx + btn_w then
			if playing then
				saveResumePosition()
				playing = false
				for _, speaker in ipairs(speakers) do speaker.stop() end
				os.queueEvent("playback_stopped")
				closePlayerHandle()
				if has_modem and #network_speakers > 0 then
					rednet.broadcast({ type = "stop" }, STREAM_PROTOCOL)
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
			return
		end
		cx = cx + btn_w + 1

		-- Skip button
		if x >= cx and x < cx + 4 then
			if now_playing ~= nil or #queue > 0 then
				is_error = false
				resetResumePosition(now_playing)
				if playing then
					for _, speaker in ipairs(speakers) do speaker.stop() end
					os.queueEvent("playback_stopped")
					closePlayerHandle()
					if has_modem and #network_speakers > 0 then
						rednet.broadcast({ type = "stop" }, STREAM_PROTOCOL)
					end
				end
				if #queue > 0 then
					if looping == 1 then table.insert(queue, now_playing) end
					now_playing = queue[1]
					table.remove(queue, 1)
					playing_id = nil
					playing = true
					clearVisualizer()
					os.queueEvent("audio_update")
				else
					now_playing = nil
					playing = false
					playing_id = nil
					clearVisualizer()
				end
				redrawScreen()
			end
			return
		end
		cx = cx + 5

		-- Loop button
		local loop_labels = { [0] = "Loop", [1] = "L.Q", [2] = "L.1" }
		local loop_w = #loop_labels[looping] + 2
		if x >= cx and x < cx + loop_w then
			looping = (looping + 1) % 3
			redrawScreen()
			return
		end
		cx = cx + loop_w + 1

		-- Shuffle button
		if x >= cx and x < cx + 5 then
			shuffled = not shuffled
			if shuffled then shuffleQueue() end
			redrawScreen()
			return
		end
	end
end

local function handleQueueClick(x, y)
	-- Header buttons (row 3)
	if y == 3 then
		local shf_x = width - 6
		if x >= shf_x and x <= width - 1 then
			shuffled = not shuffled
			if shuffled then shuffleQueue() end
			redrawScreen()
			return
		end
		local clr_x = shf_x - 6
		if x >= clr_x and x < shf_x - 1 and #queue > 0 then
			queue = {}
			queue_scroll = 0
			redrawScreen()
			return
		end
		return
	end

	-- Queue item clicks
	local list_start = 5
	local list_end = height - 2
	if y >= list_start and y <= list_end and #queue > 0 then
		local idx
		if layout_mode == LAYOUT_WIDE then
			idx = (y - list_start) + queue_scroll + 1
		else
			idx = math.floor((y - list_start) / 2) + queue_scroll + 1
		end
		if idx >= 1 and idx <= #queue then
			table.remove(queue, idx)
			if queue_scroll > 0 and queue_scroll >= #queue then
				queue_scroll = math.max(0, #queue - 1)
			end
			redrawScreen()
		end
	end
end

local function handleSearchClick(x, y)
	if y == 3 and x >= 4 and x <= width - 1 then
		waiting_for_input = true
		search_ignore_next_s_char = false
		redrawScreen()
		return
	end

	if not search_results and not last_search and local_tracks and #local_tracks > 0 and not in_search_result then
		local list_start = local_status and 8 or 7
		local list_end = height - 2
		if y >= list_start and y <= list_end then
			local idx = (y - list_start) + local_scroll + 1
			if idx >= 1 and idx <= #local_tracks then
				clicked_result = local_tracks[idx]
				in_search_result = true
				redrawScreen()
			end
		end
		return
	end

	if search_results and #search_results > 0 and y >= 5 and not in_search_result then
		local list_start = 5
		local idx
		if layout_mode == LAYOUT_WIDE then
			idx = (y - list_start) + search_scroll + 1
		else
			idx = math.floor((y - list_start) / 2) + search_scroll + 1
		end
		if idx >= 1 and idx <= #search_results then
			clicked_result = search_results[idx]
			in_search_result = true
			redrawScreen()
		end
	end
end

local function handleSearchResultMenuClick(x, y)
	local menu_y = 8

	if y == menu_y then
		-- Play now
		local r = clicked_result
		if r then
			resetResumePosition(now_playing)
			for _, speaker in ipairs(speakers) do speaker.stop() end
			os.queueEvent("playback_stopped")
			closePlayerHandle()
			if has_modem and #network_speakers > 0 then
				rednet.broadcast({ type = "stop" }, STREAM_PROTOCOL)
			end

			if r.type == "playlist" and r.playlist_items and #r.playlist_items > 0 then
				now_playing = r.playlist_items[1]
				now_playing.platform = r.platform
				queue = {}
				for i = 2, #r.playlist_items do
					local item = r.playlist_items[i]
					item.platform = r.platform
					table.insert(queue, item)
				end
				queue_scroll = 0
			else
				now_playing = makeLocalTrackFromResult(r)
			end
			playing_id = nil
			playing = true
			is_error = false
			is_loading = false
			clearVisualizer()
			in_search_result = false
			clicked_result = nil
			tab = 1
			os.queueEvent("audio_update")
			redrawScreen()
		end
		return
	end

	if y == menu_y + 2 then
		-- Play next
		local r = clicked_result
		if r then
			if r.type == "playlist" and r.playlist_items then
				for i = #r.playlist_items, 1, -1 do
					local item = r.playlist_items[i]
					item.platform = r.platform
					table.insert(queue, 1, item)
				end
			else
				table.insert(queue, 1, makeLocalTrackFromResult(r))
			end
			if shuffled then shuffleQueue() end
			in_search_result = false
			clicked_result = nil
			redrawScreen()
		end
		return
	end

	if y == menu_y + 4 then
		-- Add to queue
		local r = clicked_result
		if r then
			if r.type == "playlist" and r.playlist_items then
				for _, item in ipairs(r.playlist_items) do
					item.platform = r.platform
					table.insert(queue, item)
				end
			else
				table.insert(queue, makeLocalTrackFromResult(r))
			end
			if shuffled then shuffleQueue() end
			in_search_result = false
			clicked_result = nil
			redrawScreen()
		end
		return
	end

	if y == menu_y + 6 then
		local r = clicked_result
		if r and not r.local_path and r.type ~= "playlist" then
			startLocalDownload(r)
			in_search_result = false
			clicked_result = nil
			redrawScreen()
		end
		return
	end

	-- Cancel / any other click
	in_search_result = false
	clicked_result = nil
	redrawScreen()
end

local function handleSettingsClick(x, y)
	local settings_y = 4

	-- Loop toggle
	if y == settings_y and x >= 10 then
		looping = (looping + 1) % 3
		redrawScreen()
		return
	end
	settings_y = settings_y + 1

	-- Shuffle toggle
	if y == settings_y and x >= 10 then
		shuffled = not shuffled
		if shuffled then shuffleQueue() end
		redrawScreen()
		return
	end
	settings_y = settings_y + 1

	-- Volume slider
	if y == settings_y and x >= 10 then
		local slider_s = 10
		local slider_w = math.min(20, width - slider_s - 8)
		if slider_w < 4 then slider_w = 4 end
		if x >= slider_s and x < slider_s + slider_w then
			volume = math.max(0, math.min(MAX_VOLUME, ((x - slider_s) / slider_w) * MAX_VOLUME))
			redrawScreen()
		end
		return
	end
	settings_y = settings_y + 2

	-- Speakers section
	settings_y = settings_y + 1 -- "Speakers" header
	settings_y = settings_y + 1 -- "Local: N"
	settings_y = settings_y + #speakers -- local speaker names

	-- Network speakers row (has Discover button)
	if y == settings_y and has_modem then
		local disc_x = 4 + 10 + #tostring(#network_speakers) + 1
		if x >= disc_x then
			network_speakers = {}
			rednet.broadcast({ type = "ping" }, STREAM_PROTOCOL)
			local deadline = os.clock() + 2
			while os.clock() < deadline do
				local sender, msg, proto = rednet.receive(STREAM_PROTOCOL, deadline - os.clock())
				if sender and proto == STREAM_PROTOCOL and type(msg) == "table" and msg.type == "pong" then
					local found = false
					for _, ns in ipairs(network_speakers) do
						if ns.id == sender then found = true break end
					end
					if not found then
						table.insert(network_speakers, { id = sender, label = msg.label })
					end
				end
			end
			redrawScreen()
			return
		end
	end
	settings_y = settings_y + 1 + #network_speakers

	if not has_modem then settings_y = settings_y + 1 end
	settings_y = settings_y + 1

	-- Changelog area
	local cl_header_y = settings_y
	settings_y = settings_y + 1

	if in_changelog_item then
		if y == height - 1 then
			in_changelog_item = false
			clicked_changelog = nil
			changelog_body_scroll = 0
			redrawScreen()
		end
		return
	end

	if changelog_results and y >= settings_y and y < height - 1 then
		local idx = (y - settings_y) + changelog_scroll + 1
		if idx >= 1 and idx <= #changelog_results then
			clicked_changelog = changelog_results[idx]
			in_changelog_item = true
			changelog_body_scroll = 0
			redrawScreen()
		end
	end
end

-- ============================================================
-- NETWORK SPEAKER HELPERS
-- ============================================================

local function broadcastAudio(chunk_data, vol)
	if has_modem and #network_speakers > 0 then
		rednet.broadcast({ type = "audio", data = chunk_data, volume = vol }, STREAM_PROTOCOL)
	end
end

local function broadcastStop()
	if has_modem and #network_speakers > 0 then
		rednet.broadcast({ type = "stop" }, STREAM_PROTOCOL)
	end
end

-- ============================================================
-- UI LOOP
-- ============================================================

local function uiLoop()
	redrawScreen()
	viz_timer = os.startTimer(VIZ_TIMER_INTERVAL)

	while true do
		if waiting_for_input then
			if has_monitor then
				original_term.setBackgroundColor(C_BG)
				original_term.clear()
				original_term.setTextColor(C_LOADING)
				local tw, th = original_term.getSize()
				local tip1 = "Type here and"
				local tip2 = "press Enter"
				original_term.setCursorPos(math.max(1, math.floor((tw - #tip1) / 2) + 1), math.floor(th / 2) - 1)
				original_term.write(tip1)
				original_term.setCursorPos(math.max(1, math.floor((tw - #tip2) / 2) + 1), math.floor(th / 2))
				original_term.write(tip2)
			end
			if has_monitor then
				term.redirect(original_term)
				local tw, th = original_term.getSize()
				original_term.setBackgroundColor(C_ACCENT)
				original_term.setTextColor(colors.black)
				original_term.setCursorPos(1, math.floor(th / 2) + 1)
				original_term.clearLine()
				original_term.write("")
			else
				term.setCursorPos(5, 3)
			end
			local input = readStickySearchInput(has_monitor and (math.floor(select(2, original_term.getSize()) / 2) + 1) or 3)
			if has_monitor then
				term.redirect(monitor)
				width, height = monitor.getSize()
			end

			if string.len(input) > 0 then
				last_search = input
				search_scroll = 0
				last_search_url = api_base_url .. "?v=" .. version .. "&search=" .. textutils.urlEncode(input) .. "&t=" .. tostring(math.floor(os.clock() * 1000))
				http.request(last_search_url)
				search_results = nil
				search_error = false
				search_error_message = nil
			else
				last_search = nil
				last_search_url = nil
				search_results = nil
				search_error = false
				search_error_message = nil
			end

			waiting_for_input = false
			os.queueEvent("redraw_screen")
		else
			parallel.waitForAny(
				function()
					local event, button, x, y = pullClick()
					if button ~= 1 then return end

					-- Tab clicks
					if y <= 2 and not in_search_result and not in_changelog_item then
						local tab_w = math.floor(width / 4)
						local new_tab = math.min(4, math.floor((x - 1) / tab_w) + 1)
						if new_tab ~= tab then
							tab = new_tab
							if tab == 4 and changelog_results == nil and last_changelog_url == nil then
								last_changelog_url = api_base_url .. "?v=" .. version .. "&changelogs=1"
								http.request(last_changelog_url)
								changelog_error = false
							end
						end
						redrawScreen()
						return
					end

					if tab == 1 then
						handlePlayerClick(x, y)
					elseif tab == 2 then
						handleQueueClick(x, y)
					elseif tab == 3 and not in_search_result then
						handleSearchClick(x, y)
					elseif tab == 3 and in_search_result then
						handleSearchResultMenuClick(x, y)
					elseif tab == 4 then
						handleSettingsClick(x, y)
					end
				end,
				function()
					local event, dir, x, y = os.pullEvent("mouse_scroll")
					if in_changelog_item then
						local max_scroll = getChangelogBodyMaxScroll()
						if dir == 1 and changelog_body_scroll < max_scroll then
							changelog_body_scroll = changelog_body_scroll + 1
						elseif dir == -1 and changelog_body_scroll > 0 then
							changelog_body_scroll = changelog_body_scroll - 1
						end
					elseif tab == 2 then
						local list_end = height - 2
						local list_start = 5
						local visible
						if layout_mode == LAYOUT_WIDE then
							visible = list_end - list_start + 1
						else
							visible = math.max(1, math.floor((list_end - list_start + 1) / 2))
						end
						if dir == 1 and queue_scroll + visible < #queue then
							queue_scroll = queue_scroll + 1
						elseif dir == -1 and queue_scroll > 0 then
							queue_scroll = queue_scroll - 1
						end
					elseif tab == 3 then
						local list_end = height - 2
						local list_start = 5
						local visible
						if layout_mode == LAYOUT_WIDE then
							visible = list_end - list_start + 1
						else
							visible = math.max(1, math.floor((list_end - list_start + 1) / 2))
						end
						if search_results then
							if dir == 1 and search_scroll + visible < #search_results then
								search_scroll = search_scroll + 1
							elseif dir == -1 and search_scroll > 0 then
								search_scroll = search_scroll - 1
							end
						end
					elseif tab == 4 then
						if changelog_results then
							local _, visible = getChangelogListMetrics()
							local max_scroll = math.max(0, #changelog_results - visible)
							if dir == 1 and changelog_scroll < max_scroll then
								changelog_scroll = changelog_scroll + 1
							elseif dir == -1 and changelog_scroll > 0 then
								changelog_scroll = changelog_scroll - 1
							end
						end
					end
					redrawScreen()
				end,
				function()
					-- Volume drag
					local event, button, x, y = os.pullEvent("mouse_drag")
						if tab == 4 and not in_changelog_item then
						if y == 6 then
							local slider_s = 10
							local slider_w = math.min(20, width - slider_s - 8)
							if slider_w < 4 then slider_w = 4 end
							if x >= slider_s and x < slider_s + slider_w then
								volume = math.max(0, math.min(MAX_VOLUME, ((x - slider_s) / slider_w) * MAX_VOLUME))
								redrawScreen()
							end
						end
					end
				end,
				function()
					local event, key = os.pullEvent("key")

					if in_changelog_item then
						if key == keys.q or key == keys.backspace or key == keys.escape then
							in_changelog_item = false
							clicked_changelog = nil
							changelog_body_scroll = 0
						elseif key == keys.down then
							changelog_body_scroll = math.min(getChangelogBodyMaxScroll(), changelog_body_scroll + 1)
						elseif key == keys.up then
							changelog_body_scroll = math.max(0, changelog_body_scroll - 1)
						elseif key == keys.pageDown then
							changelog_body_scroll = math.min(getChangelogBodyMaxScroll(), changelog_body_scroll + math.max(1, height - 7))
						elseif key == keys.pageUp then
							changelog_body_scroll = math.max(0, changelog_body_scroll - math.max(1, height - 7))
						end
						redrawScreen()
						return
					end

					-- Tab navigation
					if key == keys.left then
						tab = tab > 1 and tab - 1 or 4
						if tab == 4 and changelog_results == nil and last_changelog_url == nil then
							last_changelog_url = api_base_url .. "?v=" .. version .. "&changelogs=1"
							http.request(last_changelog_url)
							changelog_error = false
						end
						redrawScreen()
					end
					if key == keys.right then
						tab = tab < 4 and tab + 1 or 1
						if tab == 4 and changelog_results == nil and last_changelog_url == nil then
							last_changelog_url = api_base_url .. "?v=" .. version .. "&changelogs=1"
							http.request(last_changelog_url)
							changelog_error = false
						end
						redrawScreen()
					end

					-- Volume
					if key == keys.equals or key == keys.numPadAdd then
						volume = math.min(MAX_VOLUME, volume + 0.1)
						redrawScreen()
					end
					if key == keys.minus or key == keys.numPadSubtract then
						volume = math.max(0, volume - 0.1)
						redrawScreen()
					end

					-- Q to go back
					if key == keys.q then
						if in_search_result then
							in_search_result = false
							clicked_result = nil
							redrawScreen()
						elseif in_changelog_item then
							in_changelog_item = false
							clicked_changelog = nil
							redrawScreen()
						end
					end

					-- Space to play/pause
					if key == keys.space and (tab == 1 or tab == 2) then
						if playing then
							saveResumePosition()
							playing = false
							for _, speaker in ipairs(speakers) do speaker.stop() end
							os.queueEvent("playback_stopped")
							closePlayerHandle()
							broadcastStop()
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
					if key == keys.n and (tab == 1 or tab == 2) then
						if now_playing ~= nil or #queue > 0 then
							is_error = false
							resetResumePosition(now_playing)
							if playing then
								for _, speaker in ipairs(speakers) do speaker.stop() end
								os.queueEvent("playback_stopped")
								closePlayerHandle()
								broadcastStop()
							end
							if #queue > 0 then
								if looping == 1 then table.insert(queue, now_playing) end
								now_playing = queue[1]
								table.remove(queue, 1)
								playing_id = nil
								playing = true
								clearVisualizer()
								os.queueEvent("audio_update")
							else
								if looping == 2 then
									playing_id = nil
									clearVisualizer()
									os.queueEvent("audio_update")
								else
									now_playing = nil
									playing = false
									playing_id = nil
									is_loading = false
									clearVisualizer()
								end
							end
							redrawScreen()
						end
					end

					-- S to search
					if key == keys.s and tab == 3 and not in_search_result then
						waiting_for_input = true
						search_ignore_next_s_char = true
						redrawScreen()
					end
				end,
				function()
					local ev, timer_id = os.pullEvent("timer")
					if timer_id == anim_timer then
						anim_frame = anim_frame + 1
						anim_timer = os.startTimer(0.5)
						if is_loading or playing then
							redrawScreen()
						end
					elseif timer_id == viz_timer then
						if playing and now_playing then
							local changed = tickVisualizer()
							if changed then
								drawVisualizerOnly()
							end
						end
						viz_timer = os.startTimer(VIZ_TIMER_INTERVAL)
					end
				end,
				function()
					os.pullEvent("redraw_screen")
					redrawScreen()
				end
			)
		end
	end
end

-- ============================================================
-- AUDIO LOOP
-- ============================================================

local function audioLoop()
	while true do
		os.pullEvent("audio_update")
		while playing and now_playing do
			local thisnowplayingid = now_playing.id
			if playing_id ~= thisnowplayingid then
				playing_id = thisnowplayingid
				local track_key = getTrackKey(now_playing)
				current_played_seconds = track_key and resume_positions[track_key] or 0
				if now_playing.local_path then
					local handle = fs.open(now_playing.local_path, "rb")
					if not handle then
						is_error = true
						playing = false
						playing_id = nil
						os.queueEvent("redraw_screen")
						break
					end
					player_handle = handle
					if current_played_seconds > 0 then
						local skip_bytes = math.floor(current_played_seconds * DFPWM_BYTES_PER_SECOND)
						if player_handle.seek then
							player_handle.seek("set", skip_bytes)
						else
							while skip_bytes > 0 do
								local skipped = player_handle.read(math.min(skip_bytes, 16 * 1024))
								if not skipped then break end
								skip_bytes = skip_bytes - #skipped
							end
						end
					end
					start = player_handle.read(4)
					size = 16 * 1024 - 4
					playing_status = 1
					needs_next_chunk = 1
					is_loading = false
					clearVisualizer()
					decoder = require("cc.audio.dfpwm").make_decoder()
					os.queueEvent("redraw_screen")
					os.queueEvent("audio_update")
				else
					local dl_url = makeDownloadUrl(now_playing)
					if current_played_seconds > 0 then
						dl_url = dl_url .. "&start=" .. math.floor(current_played_seconds)
					end
					last_download_url = dl_url
					playing_status = 0
					needs_next_chunk = 1

					http.request({ url = last_download_url, binary = true, timeout = DOWNLOAD_REQUEST_TIMEOUT })
					is_loading = true
					clearVisualizer()
					decoder = require("cc.audio.dfpwm").make_decoder()

					os.queueEvent("redraw_screen")
					os.queueEvent("audio_update")
				end
			elseif playing_status == 1 and needs_next_chunk == 1 then
				while true do
					local chunk = player_handle.read(size)
					if not chunk then
						resetResumePosition(now_playing)
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

						local buffer = decoder(chunk)

						-- Feed visualizer
						updateVisualizer(buffer)

						-- Broadcast raw DFPWM to network speakers
						broadcastAudio(chunk, volume)

						local fn = {}
						for i, speaker in ipairs(speakers) do
							fn[i] = function()
								local name = peripheral.getName(speaker)
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
								if not playing or playing_id ~= thisnowplayingid then
									return
								end
							end
						end

						if #fn > 0 then
							local ok, err = pcall(parallel.waitForAll, table.unpack(fn))
							if not ok then
								needs_next_chunk = 2
								break
							end
						end

						if not playing or playing_id ~= thisnowplayingid then
							saveResumePosition()
							needs_next_chunk = 0
							break
						end

						current_played_seconds = current_played_seconds + (#chunk / DFPWM_BYTES_PER_SECOND)
						saveResumePosition()
					end
				end
			else
				os.pullEvent("audio_update")
			end
		end
	end
end

-- ============================================================
-- HTTP LOOP
-- ============================================================

local function httpLoop()
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
				if url == local_download_url then
					-- Save the binary response into the local music dir as .dfpwm
					local ok, data = pcall(function() return handle.readAll() end)
					if ok and data and #data > 0 and local_download_path then
						local wrote = false
						local success, err = pcall(function()
							local out = fs.open(local_download_path, "wb")
							out.write(data)
							out.close()
							wrote = true
						end)
						if wrote then
							local_status = "Saved: " .. fs.getName(local_download_path) .. " (" .. getFreeSpaceString() .. ")"
							local_download_url = nil
							local_download_path = nil
							loadLocalTracks()
							os.queueEvent("redraw_screen")
						else
							local_status = "Save failed"
							local_download_url = nil
							local_download_path = nil
							os.queueEvent("redraw_screen")
						end
					else
						local_status = "Save failed"
						local_download_url = nil
						local_download_path = nil
						os.queueEvent("redraw_screen")
					end
				end
			end,
			function()
				local event, url, reason = os.pullEvent("http_failure")

				if url == last_search_url then
					search_error = true
					search_error_message = reason and tostring(reason) or nil
					os.queueEvent("redraw_screen")
				end
				if url == last_changelog_url then
					changelog_error = true
					os.queueEvent("redraw_screen")
				end
				if url == last_download_url then
					is_error = true
					is_loading = false
					os.queueEvent("redraw_screen")
				end
				if url == local_download_url then
					local_status = "Save failed"
					local_download_url = nil
					local_download_path = nil
					os.queueEvent("redraw_screen")
				end
			end
		)
	end
end

-- ============================================================
-- ENTRY POINT
-- ============================================================

parallel.waitForAny(uiLoop, audioLoop, httpLoop)
