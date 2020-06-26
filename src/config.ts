import {cosmiconfigSync} from 'cosmiconfig';
import {all as merge} from 'deepmerge';
import {validate, ValidatorResult} from 'jsonschema';
import http from 'http';
import type HttpProxy from 'http-proxy';
import * as colors from 'kleur/colors';
import path from 'path';
import {Plugin as RollupPlugin} from 'rollup';
import yargs from 'yargs-parser';

const CONFIG_NAME = 'snowpack';
const ALWAYS_EXCLUDE = ['**/node_modules/**/*', '**/.types/**/*'];

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T[P] extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepPartial<U>>
    : DeepPartial<T[P]>;
};

export type EnvVarReplacements = Record<string, string | number | true>;

/** Snowpack export map */
export type SnowpackBuildMap = {[outputLoc: string]: SnowpackSourceFile};

/** Standard file interface */
export interface SnowpackSourceFile {
  /** base extension (e.g. `.js`) */
  baseExt: string;
  /** file contents */
  code: string;
  /** expanded extension (e.g. `.proxy.js` or `.module.css`) */
  expandedExt: string;
  /** if no location on disk, assume this exists in memory */
  locOnDisk?: string;
}

export type ProxyOptions = HttpProxy.ServerOptions & {
  // Custom on: {} event handlers
  on: Record<string, Function>;
};
export type Proxy = [string, ProxyOptions];

export interface BuildOptions {
  code: string;
  contents?: string; // deprecated in favor of “code“
  filePath: string;
  isDev: boolean;
}

/** DEPRECATED */
export type __OldBuildResult = {result: string; resources?: {css?: string}};

/** map of extensions -> code (e.g. { ".js": "[code]", ".css": "[code]" }) */
export type BuildResult = string | {[fileExtension: string]: string} | __OldBuildResult;

export interface BundleOptions {
  srcDirectory: string;
  destDirectory: string;
  jsFilePaths: Set<string>;
  log: (msg, level?: 'INFO' | 'WARN' | 'ERROR') => void;
}

export interface __OldTransformOptions {
  contents: string;
  urlPath: string;
  isDev: boolean;
}

export interface SnowpackPlugin {
  /** name of the plugin */
  name: string;
  /** file extensions this plugin takes as input (e.g. [".jsx", ".js", …]) */
  input: string | string[];
  /** file extensions this plugin outputs (e.g. [".js", ".css"]) */
  output: string | string[];
  /** transform input to output */
  build?(BuildOptions): Promise<BuildResult>;
  /** bundle  */
  bundle?(BundleOptions): Promise<void>;
  /** DEPRECATED */
  transform?(__OldTransformOptions): Promise<__OldBuildResult>;
  /** DEPRECATED */
  defaultBuildScript?: string;
  /** DEPRECATED */
  knownEntrypoints?: string[];
}

// interface this library uses internally
export interface SnowpackConfig {
  install: string[];
  extends?: string;
  exclude: string[];
  knownEntrypoints: string[];
  webDependencies?: {[packageName: string]: string};
  scripts: Record<string, string>;
  plugins: ([string, any] | string)[];
  devOptions: {
    secure: boolean;
    port: number;
    out: string;
    fallback: string;
    open: string;
    bundle: boolean | undefined;
    hmr: boolean;
  };
  installOptions: {
    dest: string;
    env: EnvVarReplacements;
    treeshake?: boolean;
    installTypes: boolean;
    sourceMap?: boolean | 'inline';
    externalPackage: string[];
    alias: {[key: string]: string};
    namedExports: string[];
    rollup: {
      plugins: RollupPlugin[]; // for simplicity, only Rollup plugins are supported for now
      dedupe?: string[];
    };
  };
  buildOptions: {
    baseUrl: string;
    metaDir: string;
  };
  proxy: Proxy[];
}

export interface CLIFlags extends Omit<Partial<SnowpackConfig['installOptions']>, 'env'> {
  help?: boolean; // display help text
  version?: boolean; // display Snowpack version
  reload?: boolean;
  config?: string; // manual path to config file
  env?: string[]; // env vars
  open?: string[];
  secure?: boolean;
}

// default settings
const DEFAULT_CONFIG: Partial<SnowpackConfig> = {
  exclude: ['__tests__/**/*', '**/*.@(spec|test).*'],
  plugins: [],
  installOptions: {
    dest: 'web_modules',
    externalPackage: [],
    installTypes: false,
    env: {},
    alias: {},
    namedExports: [],
    rollup: {
      plugins: [],
      dedupe: [],
    },
  },
  devOptions: {
    secure: false,
    port: 8080,
    open: 'default',
    out: 'build',
    fallback: 'index.html',
    hmr: true,
    bundle: undefined,
  },
  buildOptions: {
    baseUrl: '/',
    metaDir: '__snowpack__',
  },
};

const configSchema = {
  type: 'object',
  properties: {
    extends: {type: 'string'},
    install: {type: 'array', items: {type: 'string'}},
    exclude: {type: 'array', items: {type: 'string'}},
    plugins: {type: 'array'},
    webDependencies: {
      type: ['object'],
      additionalProperties: {type: 'string'},
    },
    scripts: {
      type: ['object'],
      additionalProperties: {type: 'string'},
    },
    devOptions: {
      type: 'object',
      properties: {
        secure: {type: 'boolean'},
        port: {type: 'number'},
        out: {type: 'string'},
        fallback: {type: 'string'},
        bundle: {type: 'boolean'},
        open: {type: 'string'},
        hmr: {type: 'boolean'},
      },
    },
    installOptions: {
      type: 'object',
      properties: {
        dest: {type: 'string'},
        externalPackage: {type: 'array', items: {type: 'string'}},
        treeshake: {type: 'boolean'},
        installTypes: {type: 'boolean'},
        sourceMap: {oneOf: [{type: 'boolean'}, {type: 'string'}]},
        alias: {
          type: 'object',
          additionalProperties: {type: 'string'},
        },
        env: {
          type: 'object',
          additionalProperties: {
            oneOf: [
              {id: 'EnvVarString', type: 'string'},
              {id: 'EnvVarNumber', type: 'number'},
              {id: 'EnvVarTrue', type: 'boolean', enum: [true]},
            ],
          },
        },
        rollup: {
          type: 'object',
          properties: {
            plugins: {type: 'array', items: {type: 'object'}},
            dedupe: {
              type: 'array',
              items: {type: 'string'},
            },
          },
        },
      },
    },
    buildOptions: {
      type: ['object'],
      properties: {
        baseUrl: {type: 'string'},
        metaDir: {type: 'string'},
      },
    },
    proxy: {
      type: 'object',
    },
  },
};

/**
 * Convert CLI flags to an incomplete Snowpack config representation.
 * We need to be careful about setting properties here if the flag value
 * is undefined, since the deep merge strategy would then overwrite good
 * defaults with 'undefined'.
 */
function expandCliFlags(flags: CLIFlags): DeepPartial<SnowpackConfig> {
  const result = {
    installOptions: {} as any,
    devOptions: {} as any,
    buildOptions: {} as any,
  };
  const {help, version, reload, config, ...relevantFlags} = flags;
  for (const [flag, val] of Object.entries(relevantFlags)) {
    if (flag === '_' || flag.includes('-')) {
      continue;
    }
    if (configSchema.properties[flag]) {
      result[flag] = val;
      continue;
    }
    if (configSchema.properties.installOptions.properties[flag]) {
      result.installOptions[flag] = val;
      continue;
    }
    if (configSchema.properties.devOptions.properties[flag]) {
      result.devOptions[flag] = val;
      continue;
    }
    console.error(`Unknown CLI flag: "${flag}"`);
    process.exit(1);
  }
  if (result.installOptions.env) {
    result.installOptions.env = result.installOptions.env.reduce((acc, id) => {
      const index = id.indexOf('=');
      const [key, val] = index > 0 ? [id.substr(0, index), id.substr(index + 1)] : [id, true];
      acc[key] = val;
      return acc;
    }, {});
  }
  return result;
}

/**
 * Convert deprecated proxy scripts to
 * FUTURE: Remove this on next major release
 */
function handleLegacyProxyScripts(config: any) {
  for (const scriptId in config.scripts as any) {
    if (!scriptId.startsWith('proxy:')) {
      continue;
    }
    const cmdArr = config.scripts[scriptId]!.split(/\s+/);
    if (cmdArr[0] !== 'proxy') {
      handleConfigError(`scripts[${scriptId}] must use the proxy command`);
    }
    cmdArr.shift();
    const {to, _} = yargs(cmdArr);
    if (_.length !== 1) {
      handleConfigError(
        `scripts[${scriptId}] must use the format: "proxy http://SOME.URL --to /PATH"`,
      );
    }
    if (to && to[0] !== '/') {
      handleConfigError(
        `scripts[${scriptId}]: "--to ${to}" must be a URL path, and start with a "/"`,
      );
    }
    const {toUrl, fromUrl} = {fromUrl: _[0], toUrl: to};
    if (config.proxy[toUrl]) {
      handleConfigError(`scripts[${scriptId}]: Cannot overwrite proxy[${toUrl}].`);
    }
    (config.proxy as any)[toUrl] = fromUrl;
    delete config.scripts[scriptId];
  }
  return config;
}

type RawProxies = Record<string, string | ProxyOptions>;
function normalizeProxies(proxies: RawProxies): Proxy[] {
  return Object.entries(proxies).map(([pathPrefix, options]) => {
    if (typeof options !== 'string') {
      return [
        pathPrefix,
        {
          //@ts-ignore - Seems to be a strange 3.9.x bug
          on: {},
          ...options,
        },
      ];
    }
    return [
      pathPrefix,
      {
        on: {
          proxyReq: (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
            const proxyPath = proxyReq.path.split(req.url!)[0];
            proxyReq.path = proxyPath + req.url!.replace(pathPrefix, '');
          },
        },
        target: options,
        changeOrigin: true,
        secure: false,
      },
    ];
  });
}

/** resolve --dest relative to cwd, etc. */
function normalizeConfig(config: SnowpackConfig): SnowpackConfig {
  const cwd = process.cwd();
  config.knownEntrypoints = (config as any).install || [];
  config.installOptions.dest = path.resolve(cwd, config.installOptions.dest);
  config.devOptions.out = path.resolve(cwd, config.devOptions.out);
  config.exclude = Array.from(new Set([...ALWAYS_EXCLUDE, ...config.exclude]));

  if (!config.proxy) {
    config.proxy = {} as any;
  }

  // remove leading/trailing slashes
  config.buildOptions.metaDir = config.buildOptions.metaDir
    .replace(/^(\/|\\)/g, '') // replace leading slash
    .replace(/(\/|\\)$/g, ''); // replace trailing slash

  if (config.devOptions.bundle === true && !config.scripts['bundle:*']) {
    handleConfigError(`--bundle set to true, but no "bundle:*" script/plugin was provided.`);
  }

  config = handleLegacyProxyScripts(config);
  config.proxy = normalizeProxies(config.proxy as any);

  return config;
}

function handleConfigError(msg: string) {
  console.error(`[error]: ${msg}`);
  process.exit(1);
}

function handleValidationErrors(filepath: string, errors: {toString: () => string}[]) {
  console.error(colors.red(`! ${filepath || 'Configuration error'}`));
  console.error(errors.map((err) => `    - ${err.toString()}`).join('\n'));
  console.error(`    See https://www.snowpack.dev/#configuration for more info.`);
  process.exit(1);
}

function handleDeprecatedConfigError(mainMsg: string, ...msgs: string[]) {
  console.error(colors.red(mainMsg));
  msgs.forEach(console.error);
  console.error(`See https://www.snowpack.dev/#configuration for more info.`);
  process.exit(1);
}

function validateConfigAgainstV1(rawConfig: any, cliFlags: any) {
  // Moved!
  if (rawConfig.dedupe || cliFlags.dedupe) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `dedupe` is now `installOptions.rollup.dedupe`.',
    );
  }
  if (rawConfig.namedExports) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `rollup.namedExports` is no longer required. See also: installOptions.namedExports',
    );
  }
  if (rawConfig.installOptions?.rollup?.namedExports) {
    delete rawConfig.installOptions.rollup.namedExports;
    console.error(
      colors.yellow(
        '[Snowpack v2.3.0] `rollup.namedExports` is no longer required. See also: installOptions.namedExports',
      ),
    );
  }
  if (rawConfig.rollup) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] top-level `rollup` config is now `installOptions.rollup`.',
    );
  }
  if (rawConfig.installOptions?.include || cliFlags.include) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `installOptions.include` is now handled via "mount" build scripts!',
    );
  }
  if (rawConfig.installOptions?.exclude) {
    handleDeprecatedConfigError('[Snowpack v1 -> v2] `installOptions.exclude` is now `exclude`.');
  }
  if (Array.isArray(rawConfig.webDependencies)) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] The `webDependencies` array is now `install`.',
    );
  }
  if (rawConfig.knownEntrypoints) {
    handleDeprecatedConfigError('[Snowpack v1 -> v2] `knownEntrypoints` is now `install`.');
  }
  if (rawConfig.entrypoints) {
    handleDeprecatedConfigError('[Snowpack v1 -> v2] `entrypoints` is now `install`.');
  }
  if (rawConfig.include) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] All files are now included by default. "include" config is safe to remove.',
      'Whitelist & include specific folders via "mount" build scripts.',
    );
  }
  // Replaced!
  if (rawConfig.source || cliFlags.source) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `source` is now detected automatically, this config is safe to remove.',
    );
  }
  if (rawConfig.stat || cliFlags.stat) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `stat` is now the default output, this config is safe to remove.',
    );
  }
  if (
    rawConfig.scripts &&
    Object.keys(rawConfig.scripts).filter((k) => k.startsWith('lintall')).length > 0
  ) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `scripts["lintall:..."]` has been renamed to scripts["run:..."]',
    );
  }
  if (
    rawConfig.scripts &&
    Object.keys(rawConfig.scripts).filter((k) => k.startsWith('plugin:`')).length > 0
  ) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `scripts["plugin:..."]` have been renamed to scripts["build:..."].',
    );
  }
  // Removed!
  if (rawConfig.devOptions?.dist) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `devOptions.dist` is no longer required. This config is safe to remove.',
      `If you'd still like to host your src/ directory at the "/_dist/*" URL, create a mount script:',
      '    {"scripts": {"mount:src": "mount src --to /_dist_"}} `,
    );
  }
  if (rawConfig.hash || cliFlags.hash) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `installOptions.hash` has been replaced by `snowpack build`.',
    );
  }
  if (rawConfig.installOptions?.nomodule || cliFlags.nomodule) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `installOptions.nomodule` has been replaced by `snowpack build`.',
    );
  }
  if (rawConfig.installOptions?.nomoduleOutput || cliFlags.nomoduleOutput) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `installOptions.nomoduleOutput` has been replaced by `snowpack build`.',
    );
  }
  if (rawConfig.installOptions?.babel || cliFlags.babel) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `installOptions.babel` has been replaced by `snowpack build`.',
    );
  }
  if (rawConfig.installOptions?.optimize || cliFlags.optimize) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `installOptions.optimize` has been replaced by `snowpack build`.',
    );
  }
  if (rawConfig.installOptions?.strict || cliFlags.strict) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `installOptions.strict` is no longer supported.',
    );
  }
}

export function createConfiguration(
  config: Partial<SnowpackConfig>,
): [ValidatorResult['errors'], undefined] | [null, SnowpackConfig] {
  const {errors: validationErrors} = validate(config, configSchema, {
    propertyName: CONFIG_NAME,
    allowUnknownAttributes: false,
  });
  if (validationErrors.length > 0) {
    return [validationErrors, undefined];
  }
  const mergedConfig = merge<SnowpackConfig>([DEFAULT_CONFIG, config]);
  return [null, normalizeConfig(mergedConfig)];
}

export function loadAndValidateConfig(flags: CLIFlags, pkgManifest: any): SnowpackConfig {
  const explorerSync = cosmiconfigSync(CONFIG_NAME, {
    // only support these 3 types of config for now
    searchPlaces: ['package.json', 'snowpack.config.js', 'snowpack.config.json'],
    // don't support crawling up the folder tree:
    stopDir: path.dirname(process.cwd()),
  });

  let result;
  // if user specified --config path, load that
  if (flags.config) {
    result = explorerSync.load(path.resolve(process.cwd(), flags.config));
    if (!result) {
      handleConfigError(`Could not locate Snowpack config at ${flags.config}`);
    }
  }

  // If no config was found above, search for one.
  result = result || explorerSync.search();

  // If still no config found, assume none exists and use the default config.
  if (!result || !result.config || result.isEmpty) {
    result = {config: {...DEFAULT_CONFIG}};
  }

  // validate against schema; throw helpful user if invalid
  const config: SnowpackConfig = result.config;
  validateConfigAgainstV1(config, flags);
  const cliConfig = expandCliFlags(flags);

  let extendConfig: SnowpackConfig | {} = {};
  if (config.extends) {
    const extendConfigLoc = config.extends.startsWith('.')
      ? path.resolve(path.dirname(result.filepath), config.extends)
      : require.resolve(config.extends, {paths: [process.cwd()]});
    const extendResult = explorerSync.load(extendConfigLoc);
    if (!extendResult) {
      handleConfigError(`Could not locate Snowpack config at ${flags.config}`);
      process.exit(1);
    }
    extendConfig = extendResult.config;
    const extendValidation = validate(extendConfig, configSchema, {
      allowUnknownAttributes: false,
      propertyName: CONFIG_NAME,
    });
    if (extendValidation.errors && extendValidation.errors.length > 0) {
      handleValidationErrors(result.filepath, extendValidation.errors);
      process.exit(1);
    }
  }
  // if valid, apply config over defaults
  const mergedConfig = merge<SnowpackConfig>([
    pkgManifest.homepage ? {buildOptions: {baseUrl: pkgManifest.homepage}} : {},
    extendConfig,
    {webDependencies: pkgManifest.webDependencies},
    config,
    cliConfig as any,
  ]);
  for (const webDependencyName of Object.keys(mergedConfig.webDependencies || {})) {
    if (pkgManifest.dependencies && pkgManifest.dependencies[webDependencyName]) {
      handleConfigError(
        `"${webDependencyName}" is included in "webDependencies". Please remove it from your package.json "dependencies" config.`,
      );
    }
    if (pkgManifest.devDependencies && pkgManifest.devDependencies[webDependencyName]) {
      handleConfigError(
        `"${webDependencyName}" is included in "webDependencies". Please remove it from your package.json "devDependencies" config.`,
      );
    }
  }

  const [validationErrors, configResult] = createConfiguration(mergedConfig);
  if (validationErrors) {
    handleValidationErrors(result.filepath, validationErrors);
    process.exit(1);
  }
  return configResult!;
}
