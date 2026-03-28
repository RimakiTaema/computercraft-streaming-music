-- receiver.lua - Wireless Speaker Receiver
-- Run this on any ComputerCraft computer with a speaker + modem attached.
-- It will listen for audio streamed from the main music player.

local PROTOCOL = "music_stream"

local speaker = peripheral.find("speaker")
local modem = peripheral.find("modem")

if not speaker then
	error("No speaker attached. Connect a speaker to this computer.", 0)
end
if not modem then
	error("No modem attached. Connect a modem to this computer.", 0)
end

rednet.open(peripheral.getName(modem))

local decoder = require("cc.audio.dfpwm").make_decoder()
local label = os.getComputerLabel() or ("Speaker-" .. os.getComputerID())

term.clear()
term.setCursorPos(1, 1)
term.setTextColor(colors.cyan)
print("=== Wireless Speaker Receiver ===")
term.setTextColor(colors.white)
print("Computer ID: " .. os.getComputerID())
print("Label: " .. label)
print("Speaker: " .. peripheral.getName(speaker))
print("Modem: " .. peripheral.getName(modem))
print("")
term.setTextColor(colors.yellow)
print("Waiting for audio stream...")
term.setTextColor(colors.lightGray)
print("(Use Ctrl+T to stop)")

while true do
	local sender, msg, proto = rednet.receive(PROTOCOL)
	if proto == PROTOCOL and type(msg) == "table" then
		if msg.type == "audio" and msg.data then
			local buffer = decoder(msg.data)
			local vol = msg.volume or 1.5
			while not speaker.playAudio(buffer, vol) do
				os.pullEvent("speaker_audio_empty")
			end
		elseif msg.type == "stop" then
			speaker.stop()
			-- Reset decoder state for clean start on next track
			decoder = require("cc.audio.dfpwm").make_decoder()
		elseif msg.type == "ping" then
			rednet.send(sender, { type = "pong", id = os.getComputerID(), label = label }, PROTOCOL)
		end
	end
end
