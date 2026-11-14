all: bin/stamper
bin/stamper: src/stamper.cpp
	g++ -O2 -std=c++17 -o $@ $<
run: all
	php -S 0.0.0.0:8080 -t public
