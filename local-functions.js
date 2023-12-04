#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const yaml = require('yaml');
const { exec } = require('child_process');
const morgan = require('morgan');

const PORT = 9000;
const ONE_MINUTE = 60 * 1000;

const logger = morgan('combined');

const readBody = (req) => {
  return new Promise((resolve, reject) => {
    const body = [];
    req
      .on('data', (chunk) => {
        body.push(chunk);
      })
      .on('error', (err) => {
        reject(err);
      })
      .on('end', () => {
        resolve(Buffer.concat(body).toString());
      });
  });
};

const buildFunction = (route) => {
  let isBuilding = false;
  const build = () => {
    isBuilding = true;
    const buildCommand = 'npm run build';
    console.log(`running "${buildCommand}" on ${route.route}`);
    exec(
      buildCommand,
      {
        cwd: route.path,
        timeout: Math.min(route.action?.limits?.timeout ?? 2 * ONE_MINUTE, 15 * ONE_MINUTE),
      },
      (error, stdout) => {
        if (error) {
          console.log(`error building ${route.route}`);
          console.error(stdout);
          setTimeout(() => {
            isBuilding = false;
          }, 500);
          return;
        }
        console.log(`built ${route.route}`);
        setTimeout(() => {
          isBuilding = false;
        }, 500);
      }
    );
  };

  build();
  fs.watch(route.path, { recursive: true }, (file, type) => {
    if (isBuilding) {
      return;
    }
    console.log(`file ${type} detected ${file}`);
    build();
  });
};

const runFunction = async (route, params, res) => {
  return new Promise((resolve, reject) => {
    const script = `require("./${route.entrypoint}").${
      route.action.main ?? 'main'
    }(JSON.parse(process.argv[1])).then((result) => console.log("RESULT:" + JSON.stringify(result))).catch((err) => console.error(JSON.stringify(err)));`;

    exec(`node -e '${script}' "${JSON.stringify(params).replace(/"/g, '\\"')}"`, { cwd: route.path }, (error, stdout, stderr) => {
      if (error) {
        reject(stderr);
        return;
      }

      let result = null;
      for (const line of stdout.split('\n')) {
        const match = line.match(/^RESULT:(.*)$/);
        if (match) {
          result = JSON.parse(match[1]);
          continue;
        } else if (line.trim() === '') {
          continue;
        }
        console.log(line);
      }

      res.statusCode = result.statusCode ?? 200;
      res.end(JSON.stringify(result.body));
      resolve();
    });
  });
};

function main(argv) {
  const args = argv.slice(2);
  if (args.length < 2 || args[0] !== 'run-local') {
    console.log('Usage: local-functions run-local <project.yml>');
    process.exit(1);
    return;
  }
  if (!fs.existsSync(args[1])) {
    console.log(`project file ${args[1]} does not exist`);
    process.exit(1);
    return;
  }

  const project = yaml.parse(fs.readFileSync(args[1], 'utf8'));
  const packages = project?.packages;
  if (!packages || packages.length === 0) {
    console.log('no packages defined');
    process.exit(1);
    return;
  }
  const routes = [];
  for (const pkg of packages) {
    const actions = pkg?.actions ?? [];
    for (const action of actions) {
      const actionRoute = `/${pkg.name}/${action.name}`;
      const sourcePath = `packages/${pkg.name}/${action.name}`;
      if (!action.runtime.startsWith('nodejs:')) {
        console.log(`unsupported runtime ${action.runtime}`);
        continue;
      }

      if (!fs.existsSync(`${sourcePath}/package.json`)) {
        console.log(`package.json not found for action ${actionRoute}`);
        continue;
      }

      try {
        const packageJson = JSON.parse(fs.readFileSync(`${sourcePath}/package.json`, 'utf8'));
        const route = { route: actionRoute, action, path: sourcePath, entrypoint: packageJson.main ?? 'index.js' };

        routes.push(route);

        if (packageJson?.scripts?.build) {
          buildFunction(route);
        }
      } catch (e) {
        console.log(`error parsing package.json for action ${actionRoute}`);
        continue;
      }
    }
  }

  const requestHandler = async (req, res) => {
    const start = performance.now();
    logger(req, res, async (err) => {
      try {
        if (err) {
          throw err;
        }

        const url = new URL(`http://internal:${PORT}${req.url}`);
        const match = routes.find((route) => url.pathname.startsWith(route.route));
        if (!match) {
          throw new Error(`no route found for ${url.pathname}`);
        }

        const body = await readBody(req);
        const params = body ? JSON.parse(body) : {};
        await runFunction(match, params, res);

        process.stdout.write(`Duration: ${Math.round((performance.now() - start) * 1000) / 1000} ms\n`);
      } catch (err) {
        console.log(err);
        res.statusCode = 500;
        res.end('Internal server error');
      }
    });
  };

  const server = http.createServer(requestHandler);

  server.listen(PORT, () => {
    console.log(`Listening on http://localhost:${PORT}/`);
  });
}

main(process.argv);
