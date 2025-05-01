const WebSocket = require('ws');
const readline = require('readline');

const SERVER_URL = 'ws://localhost:8080';

console.log(`Intentant connectar a ${SERVER_URL}...`);
const ws = new WebSocket(SERVER_URL);

// *** NOU: Guardem la posició que ens diu el servidor ***
let currentPosition = { x: 0, y: 0 }; // Valor inicial per defecte

function displayPosition() {
     // Neteja la línia actual i mostra la posició i el prompt
     process.stdout.write('\r' + ' '.repeat(process.stdout.columns) + '\r'); // Neteja línia
     process.stdout.write(`Posició actual: (${currentPosition.x}, ${currentPosition.y}) | Mou amb fletxes (CTRL+C surt): `);
}

ws.on('open', () => {
    console.log('Connectat al servidor WebSocket!');
    console.log('Mou el jugador amb les tecles de fletxa.');
    console.log('Prem CTRL+C per sortir.');
    // No mostrem la posició inicial aquí, esperem el missatge del servidor

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }

    process.stdin.on('keypress', (str, key) => {
        if (key.ctrl && key.name === 'c') {
            console.log("\nDesconnectant...");
            ws.close();
            // setRawMode(false) es farà a l'event 'close'
            return; // Surt del handler
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

        // Si s'ha premut una tecla de moviment vàlida, envia la comanda
        if (command) {
            try {
                 // *** NOU: Envia la comanda enlloc de la posició ***
                 console.log(`\nEnviant comanda: ${command}`) // Log per debug
                ws.send(JSON.stringify({ command: command }));
                // No actualitzem la posició localment, esperem la resposta del servidor
            } catch (error) {
                console.error('\nError enviant comanda:', error);
            }
        } else {
             // Si es prem una tecla que no és de moviment, tornem a mostrar el prompt
             displayPosition();
        }
    });
});

ws.on('message', (message) => {
    try {
        const data = JSON.parse(message.toString());
        // Esborra la línia anterior abans d'escriure el nou missatge
        process.stdout.write('\r' + ' '.repeat(process.stdout.columns) + '\r');

        // *** NOU: Gestionar diferents tipus de missatges del servidor ***
        switch (data.type) {
            case 'initialState':
                 console.log("Estat inicial rebut del servidor.");
                 currentPosition.x = data.x;
                 currentPosition.y = data.y;
                 break;
            case 'positionUpdate':
                // console.log(`\nPosició actualitzada pel servidor: (${data.x}, ${data.y})`); // Log opcional
                currentPosition.x = data.x;
                currentPosition.y = data.y;
                break;
            case 'gameOver':
                console.log(`\n--- PARTIDA FINALITZADA (Game ID: ${data.gameId}) ---`);
                console.log(`   Distància (línia recta): ${data.distance}`);
                console.log(`   Durada: ${new Date(data.startTime).toLocaleTimeString()} - ${new Date(data.endTime).toLocaleTimeString()}`);
                console.log("--------------------------------------------------");
                console.log("Pots començar a moure't per iniciar una nova partida.");
                // La posició ja hauria d'haver estat resetejada pel servidor amb un 'positionUpdate' posterior
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
    // *** NOU: Mostra la posició actualitzada i el prompt ***
    displayPosition();
});

ws.on('close', (code, reason) => {
    // Intenta restaurar el mode de la terminal abans de sortir
    try {
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
    } catch (e) {
        // Ignora errors si la terminal ja no està disponible
    }
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

// Captura SIGINT (Ctrl+C) per assegurar que rawMode es desactiva
process.on('SIGINT', () => {
    console.log('\nRebut SIGINT, tancant...');
    ws.close();
    // El 'close' event hauria de gestionar la sortida i rawMode
});