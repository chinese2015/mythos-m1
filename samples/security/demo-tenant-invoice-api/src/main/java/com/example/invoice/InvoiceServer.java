package com.example.invoice;

import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;

public final class InvoiceServer {
    private InvoiceServer() {}

    public static HttpServer createServer(InetSocketAddress address) throws IOException {
        HttpServer server = HttpServer.create(address, 0);
        server.createContext("/api/invoices", new InvoiceController(new DemoPrincipalResolver(), new InvoiceStore()));
        return server;
    }

    public static void main(String[] args) throws IOException {
        int port = args.length == 0 ? 8085 : Integer.parseInt(args[0]);
        HttpServer server = createServer(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port));
        Runtime.getRuntime().addShutdownHook(new Thread(() -> server.stop(0)));
        server.start();
        System.out.println("Synthetic tenant invoice API listening on 127.0.0.1:" + port);
    }
}
