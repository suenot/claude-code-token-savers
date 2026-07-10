import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function cli(argv) {
  if (argv[0] === '--version' || argv[0] === '-v') {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    );
    console.log(pkg.version);
    return 0;
  }
  console.log('shuba: commands — run | up | down | status | doctor');
  return 0;
}
