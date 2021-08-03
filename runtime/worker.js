import { FRAME_BUFFER_SIZE } from './constants.js';
import { TAPFile, TZXFile } from './tape.js';

const run = (core) => {
    const memory = core.memory;
    const memoryData = new Uint8Array(memory.buffer);
    const workerFrameData = memoryData.subarray(core.FRAME_BUFFER, FRAME_BUFFER_SIZE);
    const registerPairs = new Uint16Array(core.memory.buffer, core.REGISTERS, 12);
    const trdosDisk = new Uint8Array(0xa0000);

    let stopped = false;
    let tape = null;

    const loadMemoryPage = (page, data) => {
        memoryData.set(data, core.MACHINE_MEMORY + page * 0x4000);
    };

    const loadSnapshot = (snapshot) => {
        core.setMachineType(snapshot.model);
        for (let page in snapshot.memoryPages) {
            loadMemoryPage(page, snapshot.memoryPages[page]);
        }
        ['AF', 'BC', 'DE', 'HL', 'AF_', 'BC_', 'DE_', 'HL_', 'IX', 'IY', 'SP', 'IR'].forEach(
            (r, i) => {
                registerPairs[i] = snapshot.registers[r];
            }
        )
        core.setPC(snapshot.registers.PC);
        core.setIFF1(snapshot.registers.iff1);
        core.setIFF2(snapshot.registers.iff2);
        core.setIM(snapshot.registers.im);
        core.setHalted(!!snapshot.halted);

        core.writePort(0x00fe, snapshot.ulaState.borderColour);
        if (snapshot.model != 48) {
            core.writePort(0x7ffd, snapshot.ulaState.pagingFlags);
        }

        core.setTStates(snapshot.tstates);
    };

    const trapTapeLoad = () => {
        if (!tape) return;
        const block = tape.getNextLoadableBlock();
        if (!block) return;

        /* get expected block type and load vs verify flag from AF' */
        const af_ = registerPairs[4];
        const expectedBlockType = af_ >> 8;
        const shouldLoad = af_ & 0x0001;  // LOAD rather than VERIFY
        let addr = registerPairs[8];  /* IX */
        const requestedLength = registerPairs[2];  /* DE */
        const actualBlockType = block[0];

        let success = true;
        if (expectedBlockType != actualBlockType) {
            success = false;
        } else {
            if (shouldLoad) {
                let offset = 1;
                let loadedBytes = 0;
                let checksum = actualBlockType;
                while (loadedBytes < requestedLength) {
                    if (offset >= block.length) {
                        /* have run out of bytes to load */
                        success = false;
                        break;
                    }
                    const byte = block[offset++];
                    loadedBytes++;
                    core.poke(addr, byte);
                    addr = (addr + 1) & 0xffff;
                    checksum ^= byte;
                }

                // if loading is going right, we should still have a checksum byte left to read
                success &= (offset < block.length);
                if (success) {
                    const expectedChecksum = block[offset];
                    success = (checksum === expectedChecksum);
                }
            } else {
                // VERIFY. TODO: actually verify.
                success = true;
            }
        }

        if (success) {
            /* set carry to indicate success */
            registerPairs[0] |= 0x0001;
        } else {
            /* reset carry to indicate failure */
            registerPairs[0] &= 0xfffe;
        }
        core.setPC(0x05e2);  /* address at which to exit the tape trap */
    }

    onmessage = (e) => {
        switch (e.data.message) {
            case 'runFrame':
                if (stopped) return;
                const frameBuffer = e.data.frameBuffer;
                const frameData = new Uint8Array(frameBuffer);

                let audioBufferLeft = null;
                let audioBufferRight = null;
                let audioLength = 0;
                if ('audioBufferLeft' in e.data) {
                    audioBufferLeft = e.data.audioBufferLeft;
                    audioBufferRight = e.data.audioBufferRight;
                    audioLength = audioBufferLeft.byteLength / 4;
                    core.setAudioSamplesPerFrame(audioLength);
                } else {
                    core.setAudioSamplesPerFrame(0);
                }

                let status = core.runFrame();
                while (status) {
                    switch (status) {
                        case 1:
                            stopped = true;
                            throw("Unrecognised opcode!");
                        case 2:
                            trapTapeLoad();
                            break;
                        default:
                            stopped = true;
                            throw("runFrame returned unexpected result: " + status);
                    }

                    status = core.resumeFrame();
                }

                frameData.set(workerFrameData);
                if (audioLength) {
                    const leftSource = new Float32Array(core.memory.buffer, core.AUDIO_BUFFER_LEFT, audioLength);
                    const rightSource = new Float32Array(core.memory.buffer, core.AUDIO_BUFFER_RIGHT, audioLength);
                    const leftData = new Float32Array(audioBufferLeft);
                    const rightData = new Float32Array(audioBufferRight);
                    leftData.set(leftSource);
                    rightData.set(rightSource);
                    postMessage({
                        message: 'frameCompleted',
                        frameBuffer,
                        audioBufferLeft,
                        audioBufferRight,
                    }, [frameBuffer, audioBufferLeft, audioBufferRight]);
                } else {
                    postMessage({
                        message: 'frameCompleted',
                        frameBuffer,
                    }, [frameBuffer]);
                }

                break;
            case 'keyDown':
                core.keyDown(e.data.row, e.data.mask);
                break;
            case 'keyUp':
                core.keyUp(e.data.row, e.data.mask);
                break;
            case 'setMachineType':
                core.setMachineType(e.data.type);
                break;
            case 'reset':
                core.reset();
                break;
            case 'loadMemory':
                loadMemoryPage(e.data.page, e.data.data);
                break;
            case 'loadSnapshot':
                loadSnapshot(e.data.snapshot);
                break;
            case 'openTAPFile':
                tape = new TAPFile(e.data.data);
                break;
            case 'openTZXFile':
                tape = new TZXFile(e.data.data);
                break;
            case 'openTRDFile':
                const trdBufferLength = Math.min(0xa0000, e.data.data.byteLength);
                const sourceBuffer = new Uint8Array(e.data.data, 0, trdBufferLength);
                trdosDisk.set(sourceBuffer);
                break;
            default:
                console.log('message received by worker:', e.data);
        }
    };

    postMessage({
        'message': 'ready',
    });
}

WebAssembly.instantiateStreaming(
    fetch('jsspeccy-core.wasm', {})
).then(results => {
    run(results.instance.exports);
});
