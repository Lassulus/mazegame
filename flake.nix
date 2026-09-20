{
  description = "A Windows 95 style maze in a browser tab - the exit is the NixOS logo";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = fn: nixpkgs.lib.genAttrs systems (system: fn nixpkgs.legacyPackages.${system});

      mkMazegame =
        pkgs:
        pkgs.python3Packages.buildPythonApplication {
          pname = "mazegame";
          version = "1.0.0";
          pyproject = true;
          src = ./.;
          build-system = [ pkgs.python3Packages.setuptools ];
          doCheck = false;
          meta = {
            description = "Browser maze game with a spectator camera; the exit is the NixOS logo";
            mainProgram = "mazegame";
            license = pkgs.lib.licenses.mit;
            platforms = pkgs.lib.platforms.all;
          };
        };

      mazegameModule =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.services.mazegame;
        in
        {
          options.services.mazegame = {
            enable = lib.mkEnableOption "the NixOS maze game server";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.mazegame;
              defaultText = lib.literalExpression "mazegame";
              description = "Package providing the mazegame server.";
            };
            host = lib.mkOption {
              type = lib.types.str;
              default = "127.0.0.1";
              description = "Address to bind. Use 0.0.0.0 to serve the network.";
            };
            port = lib.mkOption {
              type = lib.types.port;
              default = 8080;
              description = "TCP port to listen on.";
            };
            openFirewall = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "Open {option}`services.mazegame.port` in the firewall.";
            };
          };

          config = lib.mkIf cfg.enable {
            systemd.services.mazegame = {
              description = "NixOS maze game";
              wantedBy = [ "multi-user.target" ];
              after = [ "network.target" ];
              serviceConfig = {
                ExecStart = "${lib.getExe cfg.package} --host ${cfg.host} --port ${toString cfg.port} --quiet";
                Restart = "on-failure";
                DynamicUser = true;
                NoNewPrivileges = true;
                PrivateDevices = true;
                PrivateTmp = true;
                ProtectHome = true;
                ProtectSystem = "strict";
                ProtectKernelTunables = true;
                ProtectControlGroups = true;
                RestrictAddressFamilies = [
                  "AF_INET"
                  "AF_INET6"
                ];
                SystemCallFilter = [ "@system-service" ];
              };
            };

            networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
          };
        };
    in
    {
      packages = forAllSystems (pkgs: rec {
        mazegame = mkMazegame pkgs;
        default = mazegame;
      });

      overlays.default = final: _prev: { mazegame = mkMazegame final; };

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.mazegame}/bin/mazegame";
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.python3
            pkgs.ruff
          ];
        };
      });

      checks = forAllSystems (
        pkgs:
        pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          # Boots a machine with the module enabled and talks to the service,
          # so the systemd hardening is proven, not assumed.
          nixos-module = pkgs.testers.runNixOSTest {
            name = "mazegame-module";
            nodes.machine = {
              imports = [ mazegameModule ];
              services.mazegame = {
                enable = true;
                port = 8080;
              };
            };
            testScript = ''
              machine.wait_for_unit("mazegame.service")
              machine.wait_for_open_port(8080)
              machine.succeed("curl -sf http://127.0.0.1:8080/ | grep -q 'NIXOS MAZE'")
              machine.succeed("curl -sf http://127.0.0.1:8080/watch | grep -q 'MAZE CAM'")
              machine.succeed("curl -sf http://127.0.0.1:8080/js/play.js | grep -q createTouchControls")
              machine.succeed("curl -sf http://127.0.0.1:8080/img/nix-snowflake.svg | grep -q '</svg>'")
              machine.succeed("curl -sf http://127.0.0.1:8080/api/state | grep -q players")
              machine.succeed("systemctl show -p DynamicUser mazegame.service | grep -q DynamicUser=yes")
            '';
          };
        }
      );

      nixosModules = {
        default = mazegameModule;
        mazegame = mazegameModule;
      };
    };
}
