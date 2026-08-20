import { spawn } from 'child_process';
import path from 'path';

export interface GatewayDeployment {
  deploymentName: string;
  organizationSlug: string;
  apiPort: number;
  dashboardPort: number;
  dataVolumeName: string;
  redisVolumeName: string;
  apiKey: string;
}

export interface GatewayRuntime {
  createAndStart(deployment: GatewayDeployment): Promise<void>;
  start(deployment: GatewayDeployment): Promise<void>;
  stop(deployment: GatewayDeployment): Promise<void>;
  restart(deployment: GatewayDeployment): Promise<void>;
  destroy(deployment: GatewayDeployment): Promise<void>;
}

function composeFile(): string {
  return process.env.GATEWAY_COMPOSE_FILE
    || path.resolve(process.cwd(), '../../deploy/openwa-organization.compose.yml');
}

function deploymentEnvironment(deployment: GatewayDeployment): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ORGANIZATION_SLUG: deployment.organizationSlug,
    OPENWA_API_PORT: String(deployment.apiPort),
    OPENWA_DASHBOARD_PORT: String(deployment.dashboardPort),
    OPENWA_API_KEY: deployment.apiKey,
    OPENWA_DATA_VOLUME: deployment.dataVolumeName,
    OPENWA_REDIS_VOLUME: deployment.redisVolumeName,
  };
}

async function runCompose(
  deployment: GatewayDeployment,
  command: string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'docker',
      ['compose', '-f', composeFile(), '-p', deployment.deploymentName, ...command],
      {
        env: deploymentEnvironment(deployment),
        shell: false,
        windowsHide: true,
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`Docker Compose exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

export class DockerComposeGatewayRuntime implements GatewayRuntime {
  createAndStart(deployment: GatewayDeployment): Promise<void> {
    return runCompose(deployment, ['up', '-d', '--remove-orphans']);
  }

  start(deployment: GatewayDeployment): Promise<void> {
    return runCompose(deployment, ['up', '-d', '--remove-orphans']);
  }

  stop(deployment: GatewayDeployment): Promise<void> {
    return runCompose(deployment, ['stop']);
  }

  restart(deployment: GatewayDeployment): Promise<void> {
    return runCompose(deployment, ['restart']);
  }

  destroy(deployment: GatewayDeployment): Promise<void> {
    return runCompose(deployment, ['down', '--volumes', '--remove-orphans']);
  }
}
