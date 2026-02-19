#!/bin/bash
# Install dependencies
yarn install

# Install edge-tts via pip
pip install edge-tts || pip3 install edge-tts || python3 -m pip install edge-tts || echo "edge-tts install failed, will use Telnyx TTS fallback"