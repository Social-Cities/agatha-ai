module.exports = {
  apps: [
    // Standard mode — single process, poll-and-dispatch
    {
      name: "agatha-ai",
      script: "dist/worker.js",
      cwd: "",
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      node_args: "--dns-result-order=ipv4first",
      env: {
        NODE_ENV: "production",
        HOME: process.env.HOME,
        PATH: process.env.PATH,
      },
    },

    // Temporal mode — two processes (uncomment to use instead of the standard worker)
    // {
    //   name: "agatha-temporal-worker",
    //   script: "dist/temporal/worker.js",
    //   cwd: "",
    //   autorestart: true,
    //   watch: false,
    //   max_restarts: 10,
    //   restart_delay: 5000,
    //   node_args: "--dns-result-order=ipv4first",
    //   env: {
    //     NODE_ENV: "production",
    //     HOME: process.env.HOME,
    //     PATH: process.env.PATH,
    //   },
    // },
    // {
    //   name: "agatha-temporal-poller",
    //   script: "dist/temporal/start.js",
    //   cwd: "",
    //   autorestart: true,
    //   watch: false,
    //   max_restarts: 10,
    //   restart_delay: 5000,
    //   node_args: "--dns-result-order=ipv4first",
    //   env: {
    //     NODE_ENV: "production",
    //     HOME: process.env.HOME,
    //     PATH: process.env.PATH,
    //   },
    // },
  ],
};
