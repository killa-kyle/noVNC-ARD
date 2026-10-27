// Deterministic classic-script bundle; original MPL sources remain packaged.
import * as esbuild from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (esbuild.version !== '0.25.12') throw new Error('Use pinned esbuild 0.25.12');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const engine = join(root, 'Sources/ARDWebAssets/Resources/Engine');
const mit = await readFile(join(engine, 'noVNC/vendor/pako/LICENSE'), 'utf8');
const banner = `/*!\nKyleVNC ARDWebAssets classic bundle.\n` +
    `noVNC-ARD d699293635083c9e0c30c8f9480993865653772a; MPL-2.0.\n` +
    `noVNC 8e1ebdffba02e651c399dacef841f8941f6ad6e4; Copyright The noVNC authors; MPL-2.0.\n` +
    `Covered source and notices are retained in this resource bundle and at\n` +
    `https://github.com/killa-kyle/noVNC-ARD/tree/swift-package-assets\n` +
    `The independent native bootstrap is supplied in bootstrap.js.\n\n` + mit.trim() + '\n*/';
const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [join(engine, 'bootstrap.js')],
    bundle: true, format: 'esm', platform: 'browser', target: ['es2022'],
    charset: 'utf8', minify: false, legalComments: 'inline', write: false,
    banner: {js: banner},
    plugins: [{name: 'preserve-original-license-headers', setup(build) {
        build.onLoad({filter: /\.js$/}, async args => {
            let contents = await readFile(args.path, 'utf8');
            // Convert leading copyright/license comments to esbuild legal comments;
            // preserve their text verbatim and leave covered source files unchanged.
            contents = contents.replace(/^(\s*)\/\*([\s\S]*?\*\/)/, (whole, space, comment) =>
                /copyright|licensed|license|SPDX/i.test(comment) ? `${space}/*!${comment}` : whole);
            return {contents, loader: 'js', resolveDir: dirname(args.path)};
        });
    }}],
});
// Upstream capability detection contains top-level await. Preserve its order
// inside an async IIFE instead of removing checks or making them race startup.
const compiled = result.outputFiles[0].text;
if (/^\s*(import|export)\s/m.test(compiled) || compiled.includes('import.meta'))
    throw new Error('The classic bundle still contains module-only syntax');
const bytes = Buffer.from('(async () => {\n' + compiled +
    '\n})().catch(error => { console.error("ARD bundle startup failed", error); ' +
    'window.webkit?.messageHandlers?.kyleARD?.postMessage({type:"startupError",reason:String(error?.message || error).slice(0,512)}); });\n');
new Script(bytes.toString('utf8'), {filename: 'bootstrap.bundle.js'}); // Parse as classic script, without executing.
const digest = createHash('sha256').update(bytes).digest('hex');
const output = join(engine, 'bootstrap.bundle.js');
if (process.argv.includes('--check')) {
    if (!Buffer.from(await readFile(output)).equals(Buffer.from(bytes)))
        throw new Error('Checked-in classic bundle differs from reproducible build');
    if ((await readFile(join(engine, 'bootstrap.bundle.sha256'), 'utf8')).trim() !== digest)
        throw new Error('Classic bundle digest differs');
} else {
    await writeFile(output, bytes);
    await writeFile(join(engine, 'bootstrap.bundle.sha256'), digest + '\n');
}
console.log(`Classic browser bundle SHA256 ${digest} (${bytes.length} bytes)`);
