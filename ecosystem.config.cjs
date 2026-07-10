// PM2 process config. Run with: pm2 start ecosystem.config.cjs
// Using .cjs because package.json sets "type": "module" and PM2's config
// loader expects CommonJS.
module.exports = {
  apps: [
    {
      name: 'alex',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      out_file: 'logs/alex-out.log',
      error_file: 'logs/alex-error.log',
      time: true,
    },
  ],
};
