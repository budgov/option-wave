"""Offline credential-boundary checks; no request reaches a real broker."""

from __future__ import annotations

from email.message import Message
from io import BytesIO
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPSHandler, ProxyHandler, build_opener
from urllib.response import addinfourl

from option_wave.http_api import HTTPAPIConfig, HTTPAPIError, MassiveHTTPClient
from option_wave.http_security import SameOriginRedirectHandler, resolve_https_url
from option_wave.schwab_api import SchwabHTTPClient, SchwabHTTPConfig


BASE = "https://market.example"
UNSAFE_TARGETS = (
    "http://market.example/next",
    "https://other.example/next",
    "//other.example/next",
    "https://market.example:444/next",
    "https://user:password@market.example/next",
    "https://market.example@other.example/next",
    "https://market.example:invalid/next",
    "https://market.example:0/next",
    "https://market.example\\@other.example/next",
    " https://market.example/next",
    "https://market.example/next\n",
    "https://market.example/next#fragment",
    "file:///next",
)


class OfflineHTTPSHandler(HTTPSHandler):
    """Exercise urllib's real redirect dispatch without opening sockets."""

    def __init__(self, location: str, status: int = 302) -> None:
        super().__init__()
        self.location = location
        self.status = status
        self.requests = []
        self.responses = []

    def https_open(self, request):
        self.requests.append(request)
        headers = Message()
        if len(self.requests) == 1:
            headers["Location"] = self.location
            status = self.status
        else:
            status = 200
        response = addinfourl(BytesIO(b'{"results":[]}'), headers, request.full_url, status)
        response.msg = "offline response"
        self.responses.append(response)
        return response


class HTTPAPISecurityTests(unittest.TestCase):
    def setUp(self):
        network = patch("socket.create_connection", side_effect=AssertionError("offline tests must not open sockets"))
        self.network = network.start()
        self.addCleanup(network.stop)
        self.addCleanup(self.network.assert_not_called)

    @staticmethod
    def clients():
        return (
            MassiveHTTPClient(HTTPAPIConfig(base_url=BASE, api_key="offline-only-key")),
            SchwabHTTPClient(SchwabHTTPConfig(base_url=BASE, access_token="offline-only-token")),
        )

    def test_invalid_base_urls_are_rejected_without_calling_transport_or_token_provider(self):
        for target in UNSAFE_TARGETS:
            # A different HTTPS host is valid when explicitly configured as the base.
            if target in ("https://other.example/next", "https://market.example:444/next"):
                continue
            transport, token_provider = Mock(), Mock()
            with self.subTest(target=target):
                with self.assertRaises(HTTPAPIError):
                    MassiveHTTPClient(HTTPAPIConfig(base_url=target), transport=transport)
                with self.assertRaises(HTTPAPIError):
                    SchwabHTTPClient(SchwabHTTPConfig(base_url=target),
                        transport=transport, token_provider=token_provider)
                transport.assert_not_called()
                token_provider.assert_not_called()

    def test_unsafe_request_targets_are_rejected_before_any_credential_request(self):
        for client in self.clients():
            client._transport = Mock()
            for target in UNSAFE_TARGETS:
                with self.subTest(client=type(client).__name__, target=target):
                    with self.assertRaises(HTTPAPIError):
                        client._get_json(target, {})
            client._transport.assert_not_called()

    def test_unsafe_pagination_is_rejected_after_only_the_original_request(self):
        for target in UNSAFE_TARGETS:
            transport = Mock(return_value={"results": [], "next_url": target})
            client = MassiveHTTPClient(HTTPAPIConfig(base_url=BASE, api_key="offline-only-key"), transport=transport)
            with self.subTest(target=target), self.assertRaises(HTTPAPIError):
                client._paged_results("/v1/snapshot", {})
            self.assertEqual(transport.call_count, 1)

    def test_non_string_pagination_is_rejected(self):
        transport = Mock(return_value={"results": [], "next_url": {"invalid": True}})
        client = MassiveHTTPClient(HTTPAPIConfig(base_url=BASE), transport=transport)
        with self.assertRaises(HTTPAPIError):
            client._paged_results("/v1/snapshot", {})
        self.assertEqual(transport.call_count, 1)

    def test_same_origin_relative_pagination_preserves_path_and_credentials(self):
        for next_url, path in (("?cursor=two", "/v1/snapshot"),
                               ("next?cursor=two", "/v1/next"),
                               ("/v2/next?cursor=two", "/v2/next"),
                               ("https://MARKET.example:443/v2/next?cursor=two", "/v2/next")):
            transport = Mock(side_effect=[{"results": [{"page": 1}], "next_url": next_url},
                                          {"results": [{"page": 2}]}])
            client = MassiveHTTPClient(HTTPAPIConfig(base_url=BASE, api_key="offline-only-key"), transport=transport)
            with self.subTest(next_url=next_url):
                self.assertEqual(client._paged_results("/v1/snapshot", {}), [{"page": 1}, {"page": 2}])
                second = urlsplit(transport.call_args_list[1].args[0])
                self.assertEqual(second.path, path)
                self.assertEqual(parse_qs(second.query)["cursor"], ["two"])
                self.assertEqual(parse_qs(second.query)["apiKey"], ["offline-only-key"])

    def test_redirects_reject_unsafe_locations_before_a_second_request(self):
        for client in self.clients():
            for status in (301, 302, 303, 307, 308):
                for target in UNSAFE_TARGETS:
                    handler = OfflineHTTPSHandler(target, status)
                    client._opener = build_opener(ProxyHandler({}), handler, SameOriginRedirectHandler(BASE))
                    with self.subTest(client=type(client).__name__, status=status, target=target):
                        with self.assertRaises(HTTPAPIError):
                            client._get_json("/v1/snapshot", {})
                        self.assertEqual(len(handler.requests), 1)
                        self.assertTrue(handler.responses[0].closed)

    def test_legitimate_same_origin_redirects_work_for_both_adapters(self):
        for client in self.clients():
            for target in ("next", "/v2/next", "https://MARKET.example:443/next"):
                handler = OfflineHTTPSHandler(target)
                client._opener = build_opener(ProxyHandler({}), handler, SameOriginRedirectHandler(BASE))
                with self.subTest(client=type(client).__name__, target=target):
                    self.assertEqual(client._get_json("/v1/snapshot", {}), {"results": []})
                    self.assertEqual(len(handler.requests), 2)
                    if isinstance(client, SchwabHTTPClient):
                        self.assertEqual(handler.requests[1].get_header("Authorization"), "Bearer offline-only-token")

    def test_request_errors_do_not_echo_urls_or_credentials(self):
        for client in self.clients():
            client._opener = Mock()
            client._opener.open.side_effect = RuntimeError("https://market.example/?apiKey=offline-sensitive-error")
            with self.subTest(client=type(client).__name__):
                with self.assertRaises(HTTPAPIError) as captured:
                    client._get_json("/v1/snapshot", {})
                self.assertNotIn("offline-sensitive-error", str(captured.exception))
                self.assertNotIn("https://", str(captured.exception))
                self.assertTrue(captured.exception.__suppress_context__)

    def test_default_and_explicit_https_port_share_an_origin(self):
        self.assertEqual(resolve_https_url(BASE, "https://MARKET.example:443/next"),
                         "https://MARKET.example:443/next")


if __name__ == "__main__":
    unittest.main()
