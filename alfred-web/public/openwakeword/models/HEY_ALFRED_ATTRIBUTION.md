# Custom Wake word "Hey Alfred" for Home Assistant.

These instructions will guide you through downloading a new wake word, "Hey Alfred" on a running instance of Wyoming Satellite and setting it as the new activation phrase. 

If you want to build your own wake work instead of "Hey Alfred" you can follow these instructions [These instructions](https://www.home-assistant.io/voice_control/create_wake_word/) and use the generated .tflite file with the instructions below from step 4

## Install

To install The Hey Alfred wake word, you must have a [Wyoming Satellite](https://github.com/rhasspy/wyoming-satellite) up and running with local wake word detection.

You can choose where to download the files initially. I put them in the root directory, we will move and rename them later.

1. SSH into your Pi
2. Run the following in your root directory or where you would like to have this file stored in your system
   ```
   git clone https://github.com/The-Blackstone/HeyAlfredWakeWord
   ```

3. Enter the downloaded directory
   ```
   cd HeyAlfredWakeWord
   ```
4. In the file, you will see three .rflite files, all named the same but labels 1,2, and 3. 1 being the most sensitive version and 4 being the least sensitive. Pick the sensitivity that would work best for where you are going to put your assistant. If you are unsure use 3
   ```
   cp hey_alfred_sensitivity_3.tflite ~/wyoming-openwakeword/wyoming_openwakeword/models/hey_alfred_v0.1.tflite
   ```
6. Open the Wyoming services to choose the new wake command
   ```
   sudo systemctl edit --force --full wyoming-satellite.service
   ```
7. Eddit the file and change
   ```
   [Unit]
   ...
   Requires=wyoming-openwakeword.service
   
   [Service]
   ...
   ExecStart=/home/pi/wyoming-satellite/script/run ... --wake-uri 'tcp://127.0.0.1:10400' --wake-word-name 'ok_nabu'
   ...
   
   [Install]
   ...
   ```
   To
   ```
   [Unit]
   ...
   Requires=wyoming-openwakeword.service
   
   [Service]
   ...
   ExecStart=/home/pi/wyoming-satellite/script/run ... --wake-uri 'tcp://127.0.0.1:10400' --wake-word-name 'hey_alfred'
   ...
   
   [Install]
   ...
   ```
8. Save, exit and Restart Wyoming services
   ```
   sudo systemctl daemon-reload
   ```
   ```
   sudo systemctl restart wyoming-satellite.service
   ```

   
