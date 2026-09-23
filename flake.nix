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

      # One source of truth for the version: the [package] table in Cargo.toml.
      # The newline in the pattern keeps `rust-version` from being picked up
      # instead, since only the real key starts its line with "version".
      version = builtins.head (
        builtins.match ".*\nversion = \"([^\"]+)\".*" (builtins.readFile ./Cargo.toml)
      );

      mkMazegame =
        pkgs:
        let
          package = pkgs.rustPlatform.buildRustPackage {
            pname = "mazegame";
            inherit version;
            src = ./.;
            cargoLock.lockFile = ./Cargo.lock;
            # The client is data, not code, and the binary has no compiled-in
            # path to it: install it where the module's --static can point and
            # a web server can read it straight from the store.
            postInstall = ''
              mkdir -p $out/share/mazegame
              cp -r static $out/share/mazegame/static
            '';
            # The site as installed, so nginx can hand out the client without
            # going through the game loop at all.
            passthru.static = "${package}/share/mazegame/static";
            meta = {
              description = "Browser maze game with a spectator camera; the exit is the NixOS logo";
              mainProgram = "mazegame";
              license = pkgs.lib.licenses.mit;
              platforms = pkgs.lib.platforms.all;
            };
          };
        in
        package;

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
            roundGrace = lib.mkOption {
              type = lib.types.ints.positive;
              default = 120;
              description = ''
                Seconds between the first player reaching the exit and the
                whole world rolling over to a fresh maze.
              '';
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
                ExecStart = lib.concatStringsSep " " [
                  (lib.getExe cfg.package)
                  "--host ${cfg.host}"
                  "--port ${toString cfg.port}"
                  "--grace ${toString cfg.roundGrace}"
                  "--static ${cfg.package.static}"
                  "--quiet"
                ];
                Restart = "on-failure";
                # One socket per connected player; the systemd default of 1024
                # file descriptors caps the server at roughly a thousand
                # players.
                LimitNOFILE = 65536;
                # A reader and a writer thread per connection.
                TasksMax = 8192;
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

      # nixfmt-tree, not bare nixfmt: plain `nix fmt` hands the formatter a
      # directory, which nixfmt itself now refuses.
      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.mazegame}/bin/mazegame";
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.cargo
            pkgs.rustc
            pkgs.clippy
            pkgs.rustfmt
            pkgs.rust-analyzer
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
            testScript =
              let
                # A real handshake, a real position update and a real snapshot
                # back, decoded: the game is a websocket server speaking a
                # binary snapshot format, so booting and serving HTML proves
                # only half of it. The watcher is what closes the loop — it is
                # centred on the player, so the body it receives must be the
                # position the player just sent.
                wsProbe = pkgs.writers.writePython3 "mazegame-ws-probe" { } ''
                  import base64
                  import json
                  import os
                  import socket
                  import struct


                  def connect(path):
                      sock = socket.create_connection(("127.0.0.1", 8080), timeout=10)
                      key = base64.b64encode(os.urandom(16)).decode()
                      sock.sendall(
                          f"GET {path} HTTP/1.1\r\nHost: localhost\r\n"
                          f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                          f"Sec-WebSocket-Key: {key}\r\n"
                          "Sec-WebSocket-Version: 13\r\n\r\n".encode()
                      )
                      # One buffered reader for the handshake and every frame
                      # after it: the first frame can arrive in the same
                      # segment as the 101, and a raw recv() for the headers
                      # would swallow it.
                      stream = sock.makefile("rb")
                      status = stream.readline()
                      assert b"101 Switching Protocols" in status, status
                      while stream.readline() not in (b"\r\n", b""):
                          pass
                      return sock, stream


                  def send(conn, payload):
                      sock, _ = conn
                      body = json.dumps(payload).encode()
                      mask = os.urandom(4)
                      sock.sendall(
                          struct.pack("!BB", 0x81, 0x80 | len(body))
                          + mask
                          + bytes(b ^ mask[i % 4] for i, b in enumerate(body))
                      )


                  def frame(conn):
                      _, stream = conn
                      first = stream.read(2)
                      opcode = first[0] & 0x0F
                      size = first[1] & 0x7F
                      if size == 126:
                          size = struct.unpack("!H", stream.read(2))[0]
                      return opcode, stream.read(size)


                  player = connect("/ws/play?name=probe")
                  opcode, data = frame(player)
                  assert opcode == 1 and json.loads(data)["t"] == "welcome", data
                  send(player, {"t": "pos", "x": 5.5, "y": 5.5, "a": 0.0})

                  watcher = connect("/ws/watch")
                  names, seen = {}, None
                  for _ in range(40):
                      opcode, data = frame(watcher)
                      if opcode == 1:
                          message = json.loads(data)
                          if message["t"] == "names":
                              names.update({int(i): n for i, n in message["l"]})
                          continue
                      assert data[0] == 1, data[:4]  # snapshot frame
                      bodies = struct.unpack_from("<H", data, 8)[0]
                      if bodies:
                          pid, x, y, _a, _f, _age = struct.unpack_from(
                              "<IHHHBB", data, 10
                          )
                          seen = (pid, x / 1000, y / 1000)
                          break
                  assert seen is not None, "watcher never received a body"
                  assert abs(seen[1] - 5.5) < 0.01 and abs(seen[2] - 5.5) < 0.01, seen
                  assert names.get(seen[0]) == "probe", (names, seen)
                  print("websocket ok")
                '';
              in
              ''
                # Fetch, then match: `curl | grep -q` fails at random, because
                # grep exits at the first match and curl dies writing the rest
                # of the body into a closed pipe (exit 23).
                def serves(path, needle):
                    machine.succeed(f"curl -sf 'http://127.0.0.1:8080{path}' -o /tmp/body")
                    machine.succeed(f"grep -qF -- '{needle}' /tmp/body")

                machine.wait_for_unit("mazegame.service")
                machine.wait_for_open_port(8080)
                serves("/", "NIXOS MAZE")
                serves("/watch", "join the maze")
                serves("/js/play.js", "createTouchControls")
                serves("/img/nix-snowflake.svg", "</svg>")
                serves("/api/state", "perf")
                serves("/api/state?full=1", "players")
                assert "websocket ok" in machine.succeed("${wsProbe}")
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
