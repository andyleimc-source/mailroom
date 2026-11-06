// 收发状态（水位线）只有一份，在主力机上。所以凡是碰状态的命令，只准在主力机上跑。
//
// ⚠⚠ 这道闸是事故换来的：2026-09-08 在 mkp 上直接 `node bin/fetch.mjs`，绕过了
//   bin/mailroom 的转发逻辑，把 work 三天前就处理完的消息又拉了一遍（188 段）。
//   路由本来就写在 bin/mailroom 里，坏就坏在 node 入口谁都能直接叫。现在两边都堵上。
//
// 逃生口：MAILROOM_LOCAL=1（bin/mailroom 转发到主力机时会带上它，防回环）。

import { execFileSync } from 'node:child_process';

import { topology } from './config.mjs';

function localHostName() {
  try {
    return execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// 不是主力机就当场停住，并告诉人该敲什么。返回值只在 MAILROOM_LOCAL 时用得到。
export function assertPrimaryHost(subcommand) {
  if (process.env.MAILROOM_LOCAL) return true;
  const { primaryHost } = topology();
  if (!primaryHost) return true;
  const here = localHostName();
  if (!here || here === primaryHost) return true;

  process.stderr.write(
    `✗ 这台是 ${here}，收发状态（水位线）只有主力机 ${primaryHost} 上那一份。\n` +
      `  在这儿直接跑 node 入口会把主力机已经处理完的消息重收一遍。\n` +
      `  改敲：mailroom ${subcommand} …（它会自动 ssh 转到 ${primaryHost} 上执行）\n` +
      `  真要在本机跑（测试用）：MAILROOM_LOCAL=1 node bin/${subcommand}.mjs …\n`,
  );
  process.exit(3);
}
