const WebSocket = require('ws');
const readline = require('readline');

const SERVER_URL = 'ws://localhost:8080'; // URL del servidor WebSocket

console.log(`Intentant connectar a ${SERVER_URL}...`);
const ws = new WebSocket(SERVER_URL);

let position = { x: 0, y: 0 }; // Posició inicial del jugador

ws.on('open', () => {
    console.log('Connectat al servidor WebSocket!');
    console.log('Mou el jugador amb les tecles de fletxa.');
    console.log('Prem CTRL+C per sortir.');
    console.log(`Posició inicial: (${position.x}, ${position.y})`);

    // Configura readline per capturar tecles
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) { // Només si s'executa en una terminal interactiva
        process.stdin.setRawMode(true);
    }

    process.stdin.on('keypress', (str, key) => {
        // Surt amb CTRL+C
        if (key.ctrl && key.name === 'c') {
            console.log("\nDesconnectant...");
            ws.close();
            process.exit();
        }

        let moved = false;
        switch (key.name) {
            case 'up':
                position.y -= 1;
                moved = true;
                break;
            case 'down':
                position.y += 1;
                moved = true;
                break;
            case 'left':
                position.x -= 1;
                moved = true;
                break;
            case 'right':
                position.x += 1;
                moved = true;
                break;
        }

        // Si s'ha mogut, envia la nova posició
        if (moved) {
            console.log(`Nova posició: (${position.x}, ${position.y})`);
            try {
                ws.send(JSON.stringify(position));
            } catch (error) {
                console.error('Error enviant missatge:', error);
                // Podriem intentar reconectar o simplement informar
            }
        }
    });
});

ws.on('message', (message) => {
    try {
        const data = JSON.parse(message.toString());
        console.log("\nMissatge rebut del servidor:");
        // Si és un missatge de partida finalitzada
        if (data.type === 'gameOver') {
            console.log(`   Partida ${data.gameId} finalitzada!`);
            console.log(`   Distància recorreguda (línia recta): ${data.distance}`);
            console.log(`   Inici: ${new Date(data.startTime).toLocaleTimeString()}, Fi: ${new Date(data.endTime).toLocaleTimeString()}`);
            console.log("\nPots començar a moure't per iniciar una nova partida.");
        } else if (data.type === 'error') {
             console.warn(`   Error del servidor: ${data.message}`);
        } else {
            // Altres tipus de missatges (si n'hi hagués)
            console.log('  ', data);
        }
    } catch (error) {
        console.error('\nError processant missatge del servidor:', error);
        console.log('Missatge rebut (raw):', message.toString());
    }
     // Torna a mostrar el prompt per a l'usuari després de rebre un missatge
     process.stdout.write('Mou el jugador amb les tecles de fletxa (CTRL+C per sortir): ');
});

ws.on('close', (code, reason) => {
    console.log(`\nConnexió tancada. Codi: ${code}, Motiu: ${reason ? reason.toString() : 'Sense motiu'}`);
     if (process.stdin.isTTY) {
        process.stdin.setRawMode(false); // Restaura el mode normal de la terminal
    }
    process.exit(0); // Surt del procés client
});

ws.on('error', (error) => {
    console.error('Error de WebSocket:', error.message);
    console.error('No s\'ha pogut connectar al servidor. Assegura\'t que està funcionant a ' + SERVER_URL);
    if (process.stdin.isTTY) {
       process.stdin.setRawMode(false); // Restaura per si de cas
   }
    process.exit(1); // Surt amb error
});