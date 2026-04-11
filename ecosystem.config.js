module.exports = {
  apps: [
    {
      name: "github-claude-worker",
      script: "dist/worker.js",
      cwd: "",
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};