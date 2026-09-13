echo 'KEY=A=B=C==' > .testenv
IFS='=' read -r key value < .testenv
echo "KEY: $key"
echo "VALUE: $value"
