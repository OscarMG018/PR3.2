const WebSocket = require('ws');
const readline = require('readline');

const SERVER_URL = 'ws://localhost:8888';
console.log(`Intentant connectar a ${SERVER_URL}...`);
const ws = new WebSocket(SERVER_URL);
let currentPosition = { x: 0, y: 0 };

function displayPosition() {
     process.stdout.write('\r' + ' '.repeat(process.stdout.columns) + '\r');
     process.stdout.write(`Posició actual: (${currentPosition.x}, ${currentPosition.y}) | Mou amb fletxes (CTRL+C surt): `);
}

ws.on('open', () => {
    console.log('Connectat al servidor WebSocket!');
    console.log('Mou el jugador amb les tecles de fletxa.');
    console.log('Prem CTRL+C per sortir.');
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }

    process.stdin.on('keypress', (str, key) => {
        if (key.ctrl && key.name === 'c') {
            console.log("\nDesconnectant...");
            ws.close();
            return;
        }

        let command = null;
        switch (key.name) {
            case 'up':
                command = 'up';
                break;
            case 'down':
                command = 'down';
                break;
            case 'left':
                command = 'left';
                break;
            case 'right':
                command = 'right';
                break;
        }
        if (command) {
            try {
                console.log(`\nEnviant comanda: ${command}`) 
                ws.send(JSON.stringify({ command: command }));
            } catch (error) {
                console.error('\nError enviant comanda:', error);
            }
        } else {
            displayPosition();
        }
    });
});

ws.on('message', (message) => {
    try {
        const data = JSON.parse(message.toString());
        process.stdout.write('\r' + ' '.repeat(process.stdout.columns) + '\r');
        switch (data.type) {
            case 'initialState':
                 console.log("Estat inicial rebut del servidor.");
                 currentPosition.x = data.x;
                 currentPosition.y = data.y;
                 break;
            case 'positionUpdate':
                currentPosition.x = data.x;
                currentPosition.y = data.y;
                break;
            case 'gameOver':
                console.log(`\n--- PARTIDA FINALITZADA (Game ID: ${data.gameId}) ---`);
                console.log(`   Distància (línia recta): ${data.distance}`);
                console.log(`   Durada: ${new Date(data.startTime).toLocaleTimeString()} - ${new Date(data.endTime).toLocaleTimeString()}`);
                console.log("--------------------------------------------------");
                console.log("Pots començar a moure't per iniciar una nova partida.");
                break;
            case 'error':
                console.warn(`\nError del servidor: ${data.message}`);
                break;
            default:
                console.log('\nMissatge desconegut rebut del servidor:', data);
        }
    } catch (error) {
        console.error('\nError processant missatge del servidor:', error);
        console.log('Missatge rebut (raw):', message.toString());
    }
    displayPosition();
});

ws.on('close', (code, reason) => {
    try {
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
    } catch (e) {}
    console.log(`\nConnexió tancada. Codi: ${code}, Motiu: ${reason ? reason.toString() : 'Sense motiu'}`);
    process.exit(0);
});

ws.on('error', (error) => {
    try {
        if (process.stdin.isTTY) {
           process.stdin.setRawMode(false);
       }
    } catch(e) {}
    console.error('\nError de WebSocket:', error.message);
    if (error.code === 'ECONNREFUSED') {
         console.error(`No s'ha pogut connectar a ${SERVER_URL}. Assegura't que el servidor està funcionant.`);
    }
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log('\nRebut SIGINT, tancant...');
    ws.close();
});