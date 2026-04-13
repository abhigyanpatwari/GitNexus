#!/usr/bin/perl
use strict;
use warnings;
use lib 'lib';
use Utils::Logger;
use MyApp;

package main;

sub main {
    my $logger = Utils::Logger->new();
    my $app = MyApp->new();
    
    $logger->log("Starting application");
    $app->run();
    $logger->log("Application finished");
}

main();