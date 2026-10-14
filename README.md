# Discord Music Bot

A Discord music bot built with discord.js, DisTube and yt-dlp.

## Setup

1. Install [Node.js](https://nodejs.org/) (LTS).
2. `npm install`
3. Copy `.env.example` to `.env` and put your bot token in it
   (create a bot at https://discord.com/developers/applications).
4. Place `yt-dlp.exe` in the project folder (https://github.com/yt-dlp/yt-dlp/releases).
   FFmpeg is provided by `ffmpeg-static`; a local `ffmpeg.exe` is optional.
5. (Optional) For age-restricted/blocked YouTube videos, export your browser cookies to `cookies.txt`.
6. Run `node bot.js` (or `start_discord_bot.bat` on Windows for auto-restart).

## Never commit

`.env`, `cookies.txt` and `youtube_cookies.json` contain secrets and are gitignored.
