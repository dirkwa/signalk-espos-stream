// Builds the Admin UI config panel (src/configpanel) into public/ as a
// webpack Module Federation remote — the standard Signal K
// "signalk-plugin-configurator" panel build. (.cjs because the package
// itself is ESM.)
//
// This package has `"type": "module"`, and the server keys the injected
// script tag off that field: the panel is loaded as `<script type="module">`
// and the Admin UI expects an ESM federation container (`import()` +
// get/init exports). A classic `var` remote loads silently into module
// scope and the panel dies with "Module is not available" — hence
// outputModule + library type "module" below.
const path = require("path");
const { ModuleFederationPlugin } = require("webpack").container;
const packageJson = require("./package.json");

module.exports = {
  entry: "./src/configpanel/index",
  mode: "production",
  experiments: { outputModule: true },
  output: {
    path: path.resolve(__dirname, "public"),
    module: true,
    clean: false,
  },
  module: {
    rules: [
      {
        test: /\.[jt]sx?$/,
        loader: "babel-loader",
        exclude: /node_modules/,
        options: {
          presets: [
            ["@babel/preset-react", { runtime: "automatic" }],
            ["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
          ],
        },
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js", ".jsx"],
  },
  plugins: [
    new ModuleFederationPlugin({
      name: packageJson.name.replace(/[-@/]/g, "_"),
      library: { type: "module" },
      filename: "remoteEntry.js",
      exposes: {
        "./PluginConfigurationPanel":
          "./src/configpanel/PluginConfigurationPanel",
      },
      shared: {
        react: { singleton: true, requiredVersion: "^19" },
        "react-dom": { singleton: true, requiredVersion: "^19" },
      },
    }),
  ],
};
