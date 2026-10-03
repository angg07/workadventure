/// <reference path="../node_modules/@workadventure/iframe-api-typings/iframe_api.d.ts" />

const T = (x, y) => WA.player.teleport(x * 32 + 16, y * 32 + 16);

function detectFloor(px, py) {
    const tx = Math.floor(px / 32);
    if (tx <= 13) return "1";
    if (tx <= 27) return "2";
    return py > 19 * 32 ? "B" : "3";
}

// ponytail: passwords hardcoded, move to server/env when multi-room matters
const ROOM_PASSWORDS = {
    meetingA: { password: "rapat123", label: "Meeting Room A", kickTo: { x: 34, y: 5 } },
    meetingB: { password: "rapat456", label: "Meeting Room B", kickTo: { x: 34, y: 14 } },
};

WA.onInit().then(async () => {
    // --- Analytics tracking state ---
    const playerZones = new Map();
    let selfZone = "1", selfZoneStart = Date.now();
    const zoneTimes = { "1": 0, "2": 0, "3": 0, "B": 0 };
    let selfX = 0, selfY = 0;

    function updateSelfZone(newZone) {
        if (newZone === selfZone) return;
        const now = Date.now();
        zoneTimes[selfZone] += now - selfZoneStart;
        selfZone = newZone;
        selfZoneStart = now;
    }

    // --- Tangga ---
    WA.room.onEnterLayer("stairs1").subscribe(() => { T(19, 5); sendFloor("2"); });
    WA.room.onEnterLayer("stairs2down").subscribe(() => { T(10, 10); sendFloor("1"); });
    WA.room.onEnterLayer("stairs2up").subscribe(() => { T(29, 5); sendFloor("3"); });
    WA.room.onEnterLayer("stairs3").subscribe(() => { T(22, 5); sendFloor("2"); });

    // --- Floor Switcher ---
    const switcher = await WA.ui.website.open({
        url: "floor-switcher.html",
        position: { vertical: "bottom", horizontal: "left" },
        size: { height: "40px", width: "240px" },
        margin: { bottom: "10px", left: "10px" },
        allowApi: true,
    });

    function sendFloor(f) {
        switcher.iframe?.contentWindow?.postMessage({ type: "setFloor", floor: f }, "*");
    }

    WA.player.onPlayerMove((pos) => {
        const floor = detectFloor(pos.x, pos.y);
        sendFloor(floor);
        sendToMinimap({ type: "updateSelf", x: pos.x, y: pos.y });
        updateSelfZone(floor);
        selfX = pos.x; selfY = pos.y;
    });

    // --- Minimap ---
    const minimap = await WA.ui.website.open({
        url: "minimap.html",
        position: { vertical: "bottom", horizontal: "right" },
        size: { height: "164px", width: "284px" },
        margin: { bottom: "10px", right: "10px" },
        allowApi: true,
    });

    function sendToMinimap(data) {
        minimap.iframe?.contentWindow?.postMessage(data, "*");
    }

    await WA.players.configureTracking({ players: true, movement: true });

    WA.players.onPlayerEnters.subscribe((player) => {
        if (player.position) {
            sendToMinimap({ type: "updatePlayer", id: player.playerId, x: player.position.x, y: player.position.y, name: player.name });
            playerZones.set(player.playerId, { name: player.name, zone: detectFloor(player.position.x, player.position.y), x: player.position.x, y: player.position.y });
        }
    });
    WA.players.onPlayerMoves.subscribe(({ player, newPosition }) => {
        sendToMinimap({ type: "updatePlayer", id: player.playerId, x: newPosition.x, y: newPosition.y, name: player.name });
        playerZones.set(player.playerId, { name: player.name, zone: detectFloor(newPosition.x, newPosition.y), x: newPosition.x, y: newPosition.y });
    });
    WA.players.onPlayerLeaves.subscribe((player) => {
        sendToMinimap({ type: "removePlayer", id: player.playerId });
        playerZones.delete(player.playerId);
    });

    // --- Password-Protected Rooms ---
    const unlockedRooms = new Set(); // ponytail: per-session memory, resets on reload

    const pwdPrompt = await WA.ui.website.open({
        url: "password-prompt.html",
        position: { vertical: "middle", horizontal: "middle" },
        size: { height: "220px", width: "340px" },
        visible: false,
        allowApi: true,
    });

    function showPasswordPrompt(roomKey) {
        const cfg = ROOM_PASSWORDS[roomKey];
        pwdPrompt.visible = true;
        pwdPrompt.iframe?.contentWindow?.postMessage({
            type: "configure",
            room: roomKey,
            password: cfg.password,
            label: cfg.label,
        }, "*");
    }

    window.addEventListener("message", (e) => {
        if (e.data?.type === "passwordOk") {
            unlockedRooms.add(e.data.room);
            pwdPrompt.visible = false;
            WA.chat.sendChatMessage("🔓 " + ROOM_PASSWORDS[e.data.room].label + " unlocked!", "System");
        } else if (e.data?.type === "passwordCancel") {
            pwdPrompt.visible = false;
            const cfg = ROOM_PASSWORDS[e.data.room];
            T(cfg.kickTo.x, cfg.kickTo.y);
        } else if (e.data?.type === "toggleAnalytics") {
            analyticsDash.visible = !analyticsDash.visible;
            analyticsToggle.iframe?.contentWindow?.postMessage({ type: "analyticsState", visible: analyticsDash.visible }, "*");
        }
    });

    for (const [roomKey, cfg] of Object.entries(ROOM_PASSWORDS)) {
        const layerName = roomKey === "meetingA" ? "doorA" : "doorB";
        WA.room.onEnterLayer(layerName).subscribe(() => {
            if (!unlockedRooms.has(roomKey)) {
                showPasswordPrompt(roomKey);
            }
        });
    }

    // --- Analytics Dashboard ---
    const analyticsToggle = await WA.ui.website.open({
        url: "analytics-toggle.html",
        position: { vertical: "top", horizontal: "right" },
        size: { height: "36px", width: "36px" },
        margin: { top: "10px", right: "10px" },
    });

    const analyticsDash = await WA.ui.website.open({
        url: "analytics.html",
        position: { vertical: "top", horizontal: "right" },
        size: { height: "440px", width: "300px" },
        margin: { top: "52px", right: "10px" },
        visible: false,
    });

    function sendAnalyticsUpdate() {
        if (!analyticsDash.visible) return;
        const now = Date.now();
        const currentTimes = { ...zoneTimes };
        currentTimes[selfZone] += now - selfZoneStart;
        const players = {};
        playerZones.forEach((v, k) => { players[k] = v; });
        analyticsDash.iframe?.contentWindow?.postMessage({
            type: "analyticsUpdate", players, selfZone, zoneTimes: currentTimes, selfX, selfY,
        }, "*");
    }

    setInterval(sendAnalyticsUpdate, 1000);
});
