const apiPort = Number(process.env.API_PORT || process.env.PORT || 8080);
const webPort = Number(process.env.WEB_PORT || 3000);
const apiUrl = process.env.API_URL || `http://localhost:${apiPort}`;

module.exports = {
	apps: [
		{
			name: "ipod-api",
			script: "standalone-server.js",
			cwd: "./functions",
			interpreter: "node",
			env: {
				NODE_ENV: "production",
				PORT: apiPort,
			},
			instances: 1,
			autorestart: true,
			watch: false,
			max_memory_restart: "256M",
			log_date_format: "YYYY-MM-DD HH:mm:ss",
			error_file: "./logs/api-error.log",
			out_file: "./logs/api-out.log",
			merge_logs: true,
			time: true,
		},
		{
			name: "ipod-web",
			script: "start-next.js",
			interpreter: "node",
			cwd: "./web",
			env: {
				NODE_ENV: "production",
				PORT: webPort,
				API_URL: apiUrl,
			},
			instances: 1,
			autorestart: true,
			watch: false,
			max_memory_restart: "512M",
			log_date_format: "YYYY-MM-DD HH:mm:ss",
			error_file: "./logs/web-error.log",
			out_file: "./logs/web-out.log",
			merge_logs: true,
			time: true,
		},
	],
};
