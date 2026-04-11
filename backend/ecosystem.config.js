module.exports = {
  apps: [{
    name: 'quiz-server',
    script: 'server.js',
    instances: 1,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
    },
    listen_timeout: 10000,
    kill_timeout: 5000,
  }],
};
